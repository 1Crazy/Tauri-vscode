//---------------------------------------------------------------------------------------------
//  Copyright (c) Microsoft Corporation. All rights reserved.
//  Licensed under the MIT License. See License.txt in the project root for license information.
//---------------------------------------------------------------------------------------------

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::env;
use std::ffi::OsString;
use std::fs;
use std::io;
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};

#[derive(Default)]
struct AppState {
	code_web_child: Mutex<Option<Child>>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TauriHandleDescriptor {
	kind: String,
	name: String,
	path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TauriFileContents {
	name: String,
	last_modified: u64,
	data: Vec<u8>,
}

fn main() {
	tauri::Builder::default()
		.manage(AppState::default())
		.invoke_handler(tauri::generate_handler![
			tauri_shell_pick_directory,
			tauri_shell_list_directory,
			tauri_shell_get_directory_handle,
			tauri_shell_get_file_handle,
			tauri_shell_get_file,
			tauri_shell_write_file,
			tauri_shell_remove_entry
		])
		.setup(|app| {
			let repo_root = repo_root()?;
			let port = reserve_loopback_port()?;
			let mut child = spawn_code_web_server(&repo_root, port)?;

			wait_for_server(&mut child, port, Duration::from_secs(30))?;

			app.state::<AppState>()
				.code_web_child
				.lock()
				.expect("app state mutex should not be poisoned")
				.replace(child);

			let window_url = url::Url::parse(&format!("http://127.0.0.1:{port}/"))?;

			let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(window_url))
				.title("Code OSS (Tauri Shell)")
				.inner_size(1400.0, 900.0)
				.min_inner_size(1024.0, 640.0)
				.initialization_script(include_str!("tauri_fs_bridge.js"))
				.build()?;

			#[cfg(debug_assertions)]
			window.open_devtools();

			Ok(())
		})
		.build(tauri::generate_context!())
		.expect("failed to build Tauri application")
		.run(|app_handle, event| match event {
			RunEvent::Exit | RunEvent::ExitRequested { .. } => stop_code_web_server(app_handle),
			_ => {}
		});
}

fn repo_root() -> io::Result<PathBuf> {
	if let Some(repo_root) = option_env!("TAURI_SHELL_REPO_ROOT") {
		return Ok(PathBuf::from(repo_root));
	}

	let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
	let shell_root = manifest_dir
		.parent()
		.ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "failed to resolve tauri shell root"))?;

	shell_root
		.parent()
		.map(PathBuf::from)
		.ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "failed to resolve repository root"))
}

fn reserve_loopback_port() -> io::Result<u16> {
	let listener = TcpListener::bind(("127.0.0.1", 0))?;
	let port = listener.local_addr()?.port();
	drop(listener);
	Ok(port)
}

fn spawn_code_web_server(repo_root: &PathBuf, port: u16) -> io::Result<Child> {
	let node_binary = env::var_os("NODE_BINARY")
		.or_else(|| env::var_os("npm_node_execpath"))
		.or_else(|| option_env!("TAURI_SHELL_NODE_BINARY").map(OsString::from))
		.unwrap_or_else(|| OsString::from("node"));

	Command::new(node_binary)
		.current_dir(repo_root)
		.arg("scripts/code-web.js")
		.arg("--host")
		.arg("127.0.0.1")
		.arg("--port")
		.arg(port.to_string())
		.arg("--browserType")
		.arg("none")
		.stdin(Stdio::null())
		.stdout(Stdio::inherit())
		.stderr(Stdio::inherit())
		.spawn()
}

fn wait_for_server(child: &mut Child, port: u16, timeout: Duration) -> io::Result<()> {
	let deadline = Instant::now() + timeout;

	loop {
		if TcpStream::connect(("127.0.0.1", port)).is_ok() {
			return Ok(());
		}

		if let Some(status) = child.try_wait()? {
			return Err(io::Error::new(
				io::ErrorKind::Other,
				format!("code-web server exited before startup completed: {status}"),
			));
		}

		if Instant::now() >= deadline {
			return Err(io::Error::new(
				io::ErrorKind::TimedOut,
				format!("timed out waiting for code-web server on 127.0.0.1:{port}"),
			));
		}

		thread::sleep(Duration::from_millis(250));
	}
}

fn stop_code_web_server(app_handle: &AppHandle) {
	let state = app_handle.state::<AppState>();
	let mut guard = match state.code_web_child.lock() {
		Ok(guard) => guard,
		Err(_) => return,
	};

	if let Some(mut child) = guard.take() {
		let _ = child.kill();
		let _ = child.wait();
	}
}

#[tauri::command]
fn tauri_shell_pick_directory() -> Result<Option<TauriHandleDescriptor>, String> {
	match pick_directory_path().map_err(|error| error.to_string())? {
		Some(path) => Ok(Some(directory_descriptor(path)?)),
		None => Ok(None),
	}
}

#[tauri::command]
fn tauri_shell_list_directory(path: String) -> Result<Vec<TauriHandleDescriptor>, String> {
	let directory = canonicalize_existing_path(PathBuf::from(&path))?;
	let mut entries = Vec::new();

	for entry in fs::read_dir(&directory).map_err(|error| error.to_string())? {
		let entry = entry.map_err(|error| error.to_string())?;
		let path = entry.path();
		let metadata = entry.metadata().map_err(|error| error.to_string())?;

		if metadata.is_dir() {
			entries.push(directory_descriptor(path)?);
		} else if metadata.is_file() {
			entries.push(file_descriptor(path)?);
		}
	}

	entries.sort_by(|left, right| left.name.to_lowercase().cmp(&right.name.to_lowercase()));
	eprintln!(
		"[tauri-fs] readdir {} -> {} entries",
		directory.display(),
		entries.len()
	);

	Ok(entries)
}

#[tauri::command]
fn tauri_shell_get_directory_handle(path: String, name: String, create: bool) -> Result<TauriHandleDescriptor, String> {
	let directory = resolve_child_path(PathBuf::from(path), &name)?;
	if create {
		fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
	}

	let metadata = fs::metadata(&directory).map_err(|error| error.to_string())?;
	if !metadata.is_dir() {
		return Err(format!("Path is not a directory: {}", directory.display()));
	}

	directory_descriptor(directory)
}

#[tauri::command]
fn tauri_shell_get_file_handle(path: String, name: String, create: bool) -> Result<TauriHandleDescriptor, String> {
	let file_path = resolve_child_path(PathBuf::from(path), &name)?;
	if create && !file_path.exists() {
		if let Some(parent) = file_path.parent() {
			fs::create_dir_all(parent).map_err(|error| error.to_string())?;
		}
		fs::write(&file_path, []).map_err(|error| error.to_string())?;
	}

	let metadata = fs::metadata(&file_path).map_err(|error| error.to_string())?;
	if !metadata.is_file() {
		return Err(format!("Path is not a file: {}", file_path.display()));
	}

	file_descriptor(file_path)
}

#[tauri::command]
fn tauri_shell_get_file(path: String) -> Result<TauriFileContents, String> {
	let file_path = canonicalize_existing_path(PathBuf::from(path))?;
	let metadata = fs::metadata(&file_path).map_err(|error| error.to_string())?;
	if !metadata.is_file() {
		return Err(format!("Path is not a file: {}", file_path.display()));
	}

	let data = fs::read(&file_path).map_err(|error| error.to_string())?;
	let last_modified = metadata
		.modified()
		.ok()
		.and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
		.map(|duration| duration.as_millis() as u64)
		.unwrap_or_default();

	Ok(TauriFileContents {
		name: display_name(&file_path)?,
		last_modified,
		data,
	})
}

#[tauri::command]
fn tauri_shell_write_file(path: String, data: Vec<u8>) -> Result<(), String> {
	let file_path = PathBuf::from(path);
	if let Some(parent) = file_path.parent() {
		fs::create_dir_all(parent).map_err(|error| error.to_string())?;
	}

	fs::write(file_path, data).map_err(|error| error.to_string())
}

#[tauri::command]
fn tauri_shell_remove_entry(path: String, name: String, recursive: bool) -> Result<(), String> {
	let target = resolve_child_path(PathBuf::from(path), &name)?;
	let metadata = fs::metadata(&target).map_err(|error| error.to_string())?;

	if metadata.is_dir() {
		if recursive {
			fs::remove_dir_all(target).map_err(|error| error.to_string())
		} else {
			fs::remove_dir(target).map_err(|error| error.to_string())
		}
	} else {
		fs::remove_file(target).map_err(|error| error.to_string())
	}
}

fn directory_descriptor(path: PathBuf) -> Result<TauriHandleDescriptor, String> {
	handle_descriptor(path, "directory")
}

fn file_descriptor(path: PathBuf) -> Result<TauriHandleDescriptor, String> {
	handle_descriptor(path, "file")
}

fn handle_descriptor(path: PathBuf, kind: &str) -> Result<TauriHandleDescriptor, String> {
	let canonical_path = canonicalize_existing_path(path)?;

	Ok(TauriHandleDescriptor {
		kind: kind.to_string(),
		name: display_name(&canonical_path)?,
		path: canonical_path.to_string_lossy().into_owned(),
	})
}

fn canonicalize_existing_path(path: PathBuf) -> Result<PathBuf, String> {
	fs::canonicalize(path).map_err(|error| error.to_string())
}

fn display_name(path: &Path) -> Result<String, String> {
	if let Some(name) = path.file_name() {
		return Ok(name.to_string_lossy().into_owned());
	}

	let display = path.display().to_string();
	if display.is_empty() {
		return Err("Unable to determine path display name".to_string());
	}

	Ok(display)
}

fn resolve_child_path(parent: PathBuf, name: &str) -> Result<PathBuf, String> {
	if name.is_empty() || name == "." || name == ".." || name.contains(std::path::MAIN_SEPARATOR) || name.contains('/') || name.contains('\\') {
		return Err(format!("Invalid child path segment: {name}"));
	}

	Ok(parent.join(name))
}

fn pick_directory_path() -> io::Result<Option<PathBuf>> {
	#[cfg(target_os = "macos")]
	{
		return pick_directory_path_macos();
	}

	#[cfg(target_os = "windows")]
	{
		return pick_directory_path_windows();
	}

	#[cfg(all(unix, not(target_os = "macos")))]
	{
		return pick_directory_path_linux();
	}

	#[allow(unreachable_code)]
	Ok(None)
}

#[cfg(target_os = "macos")]
fn pick_directory_path_macos() -> io::Result<Option<PathBuf>> {
	let output = Command::new("osascript")
		.arg("-e")
		.arg(r#"try"#)
		.arg("-e")
		.arg(r#"POSIX path of (choose folder with prompt "Open Folder")"#)
		.arg("-e")
		.arg(r#"on error number -128"#)
		.arg("-e")
		.arg("return \"\"")
		.arg("-e")
		.arg(r#"end try"#)
		.stdout(Stdio::piped())
		.stderr(Stdio::piped())
		.output()?;

	if !output.status.success() {
		return Err(io::Error::new(
			io::ErrorKind::Other,
			String::from_utf8_lossy(&output.stderr).trim().to_string(),
		));
	}

	let selected = String::from_utf8_lossy(&output.stdout).trim().to_string();
	if selected.is_empty() {
		return Ok(None);
	}

	Ok(Some(PathBuf::from(selected)))
}

#[cfg(target_os = "windows")]
fn pick_directory_path_windows() -> io::Result<Option<PathBuf>> {
	let output = Command::new("powershell")
		.arg("-NoProfile")
		.arg("-STA")
		.arg("-Command")
		.arg(concat!(
			"Add-Type -AssemblyName System.Windows.Forms; ",
			"$dialog = New-Object System.Windows.Forms.FolderBrowserDialog; ",
			"if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { ",
			"[Console]::Out.Write($dialog.SelectedPath) }"
		))
		.stdout(Stdio::piped())
		.stderr(Stdio::piped())
		.output()?;

	if !output.status.success() {
		return Err(io::Error::new(
			io::ErrorKind::Other,
			String::from_utf8_lossy(&output.stderr).trim().to_string(),
		));
	}

	let selected = String::from_utf8_lossy(&output.stdout).trim().to_string();
	if selected.is_empty() {
		return Ok(None);
	}

	Ok(Some(PathBuf::from(selected)))
}

#[cfg(all(unix, not(target_os = "macos")))]
fn pick_directory_path_linux() -> io::Result<Option<PathBuf>> {
	if let Some(path) = try_pick_directory_with_command("zenity", ["--file-selection", "--directory", "--title=Open Folder"])? {
		return Ok(Some(path));
	}

	if let Some(path) = try_pick_directory_with_command("kdialog", ["--getexistingdirectory", "."])? {
		return Ok(Some(path));
	}

	Ok(None)
}

#[cfg(all(unix, not(target_os = "macos")))]
fn try_pick_directory_with_command<const N: usize>(program: &str, args: [&str; N]) -> io::Result<Option<PathBuf>> {
	let output = match Command::new(program)
		.args(args)
		.stdout(Stdio::piped())
		.stderr(Stdio::piped())
		.output()
	{
		Ok(output) => output,
		Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
		Err(error) => return Err(error),
	};

	if !output.status.success() {
		return Ok(None);
	}

	let selected = String::from_utf8_lossy(&output.stdout).trim().to_string();
	if selected.is_empty() {
		return Ok(None);
	}

	Ok(Some(PathBuf::from(selected)))
}
