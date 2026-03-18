//---------------------------------------------------------------------------------------------
//  Copyright (c) Microsoft Corporation. All rights reserved.
//  Licensed under the MIT License. See License.txt in the project root for license information.
//---------------------------------------------------------------------------------------------

use std::fs;
use std::io::{self, BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Component, Path, PathBuf};
use std::thread;

const INDEX_HTML_ROUTE: &str = "/";
const CALLBACK_ROUTE: &str = "/callback";

pub fn start_bundled_web_server(bundle_root: PathBuf, port: u16) -> io::Result<()> {
	validate_bundle_root(&bundle_root)?;

	let listener = TcpListener::bind(("127.0.0.1", port))?;
	thread::spawn(move || {
		for stream in listener.incoming() {
			match stream {
				Ok(stream) => {
					let bundle_root = bundle_root.clone();
					thread::spawn(move || {
						if let Err(error) = handle_connection(stream, &bundle_root) {
							eprintln!("[tauri-web] request failed: {error}");
						}
					});
				}
				Err(error) => {
					eprintln!("[tauri-web] listener stopped: {error}");
					break;
				}
			}
		}
	});

	Ok(())
}

fn validate_bundle_root(bundle_root: &Path) -> io::Result<()> {
	let required_paths = [
		bundle_root.join("out").join("nls.messages.js"),
		bundle_root
			.join("out")
			.join("vs")
			.join("workbench")
			.join("workbench.web.main.internal.js"),
		bundle_root
			.join("out")
			.join("vs")
			.join("workbench")
			.join("workbench.web.main.internal.css"),
		bundle_root.join("extensions"),
		bundle_root.join("node_modules"),
		bundle_root.join("resources").join("server").join("manifest.json"),
	];

	for required_path in required_paths {
		if !required_path.exists() {
			return Err(io::Error::new(
				io::ErrorKind::NotFound,
				format!("missing bundled web asset: {}", required_path.display()),
			));
		}
	}

	Ok(())
}

fn handle_connection(mut stream: TcpStream, bundle_root: &Path) -> io::Result<()> {
	let mut request_reader = BufReader::new(stream.try_clone()?);
	let mut request_line = String::new();
	if request_reader.read_line(&mut request_line)? == 0 {
		return Ok(());
	}

	let mut request_parts = request_line.split_whitespace();
	let method = request_parts.next().unwrap_or_default();
	let request_target = request_parts.next().unwrap_or(INDEX_HTML_ROUTE);

	loop {
		let mut header_line = String::new();
		let bytes_read = request_reader.read_line(&mut header_line)?;
		if bytes_read == 0 || header_line == "\r\n" || header_line == "\n" {
			break;
		}
	}

	if method != "GET" && method != "HEAD" {
		return write_response(
			&mut stream,
			405,
			"Method Not Allowed",
			"text/plain; charset=utf-8",
			if method == "HEAD" {
				&[]
			} else {
				b"Method Not Allowed"
			},
			method == "HEAD",
		);
	}

	let request_path = request_target
		.split_once('?')
		.map(|(path, _)| path)
		.unwrap_or(request_target);

	match request_path {
		INDEX_HTML_ROUTE | "/index.html" => {
			let body = render_index_html();
			write_response(
				&mut stream,
				200,
				"OK",
				"text/html; charset=utf-8",
				body.as_bytes(),
				method == "HEAD",
			)
		}
		CALLBACK_ROUTE | "/callback.html" => {
			let callback_path = bundle_root
				.join("out")
				.join("vs")
				.join("code")
				.join("browser")
				.join("workbench")
				.join("callback.html");
			serve_static_file(&mut stream, &callback_path, method == "HEAD")
		}
		_ => match resolve_static_path(bundle_root, request_path) {
			Some(file_path) => serve_static_file(&mut stream, &file_path, method == "HEAD"),
			None => write_response(
				&mut stream,
				404,
				"Not Found",
				"text/plain; charset=utf-8",
				b"Not found",
				method == "HEAD",
			),
		},
	}
}

fn resolve_static_path(bundle_root: &Path, request_path: &str) -> Option<PathBuf> {
	let trimmed_path = request_path.trim_start_matches('/');
	if trimmed_path.is_empty() {
		return None;
	}

	let mut resolved_path = bundle_root.to_path_buf();
	for component in Path::new(trimmed_path).components() {
		match component {
			Component::Normal(value) => resolved_path.push(value),
			Component::CurDir => {}
			_ => return None,
		}
	}

	Some(resolved_path)
}

fn serve_static_file(stream: &mut TcpStream, file_path: &Path, is_head_request: bool) -> io::Result<()> {
	match fs::read(file_path) {
		Ok(contents) => write_response(
			stream,
			200,
			"OK",
			content_type_for_path(file_path),
			&contents,
			is_head_request,
		),
		Err(error) if error.kind() == io::ErrorKind::NotFound => write_response(
			stream,
			404,
			"Not Found",
			"text/plain; charset=utf-8",
			b"Not found",
			is_head_request,
		),
		Err(error) => Err(error),
	}
}

fn write_response(
	stream: &mut TcpStream,
	status_code: u16,
	status_text: &str,
	content_type: &str,
	body: &[u8],
	is_head_request: bool,
) -> io::Result<()> {
	write!(
		stream,
		"HTTP/1.1 {status_code} {status_text}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n",
		body.len()
	)?;

	if !is_head_request {
		stream.write_all(body)?;
	}

	stream.flush()
}

fn content_type_for_path(file_path: &Path) -> &'static str {
	match file_path.extension().and_then(|extension| extension.to_str()) {
		Some("css") => "text/css; charset=utf-8",
		Some("html") => "text/html; charset=utf-8",
		Some("ico") => "image/x-icon",
		Some("js") => "text/javascript; charset=utf-8",
		Some("json") => "application/json; charset=utf-8",
		Some("map") => "application/json; charset=utf-8",
		Some("md") | Some("scm") | Some("txt") => "text/plain; charset=utf-8",
		Some("mp3") => "audio/mpeg",
		Some("png") => "image/png",
		Some("svg") => "image/svg+xml",
		Some("ttf") => "font/ttf",
		Some("wasm") => "application/wasm",
		Some("woff") => "font/woff",
		Some("woff2") => "font/woff2",
		_ => "application/octet-stream",
	}
}

fn render_index_html() -> String {
	r#"<!DOCTYPE html>
<html>
	<head>
		<meta charset="utf-8" />
		<meta name="mobile-web-app-capable" content="yes" />
		<meta name="apple-mobile-web-app-capable" content="yes" />
		<meta name="apple-mobile-web-app-title" content="Code OSS Tauri Shell" />
		<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, minimum-scale=1.0, user-scalable=no" />
		<link rel="apple-touch-icon" href="/resources/server/code-192.png" />
		<link rel="icon" href="/resources/server/favicon.ico" type="image/x-icon" />
		<link rel="manifest" href="/resources/server/manifest.json" crossorigin="use-credentials" />
		<link rel="stylesheet" href="/out/vs/workbench/workbench.web.main.internal.css" />
	</head>
	<body aria-label="">
	</body>
	<script>
		performance.mark('code/didStartRenderer');
		globalThis._VSCODE_FILE_ROOT = new URL('/out/', window.location.origin).toString();
	</script>
	<script type="module" src="/out/nls.messages.js"></script>
	<script type="module">
		import { create, URI } from '/out/vs/workbench/workbench.web.main.internal.js';

		const query = new URL(window.location.href).searchParams;
		let workspace;
		if (query.has('folder')) {
			workspace = { folderUri: URI.parse(query.get('folder')) };
		} else if (query.has('workspace')) {
			workspace = { workspaceUri: URI.parse(query.get('workspace')) };
		}

		let payload = Object.create(null);
		const rawPayload = query.get('payload');
		if (rawPayload) {
			try {
				payload = JSON.parse(rawPayload);
			} catch (error) {
				console.error(error);
			}
		}

		const workspaceProvider = {
			workspace,
			payload,
			trusted: true,
			async open(nextWorkspace, options) {
				const targetUrl = new URL(window.location.href);
				targetUrl.search = '';

				if (!nextWorkspace) {
					targetUrl.searchParams.set('ew', 'true');
				} else if (nextWorkspace.folderUri) {
					targetUrl.searchParams.set('folder', nextWorkspace.folderUri.toString());
				} else if (nextWorkspace.workspaceUri) {
					targetUrl.searchParams.set('workspace', nextWorkspace.workspaceUri.toString());
				}

				if (options?.payload) {
					targetUrl.searchParams.set('payload', JSON.stringify(options.payload));
				}

				if (options?.reuse) {
					window.location.href = targetUrl.toString();
					return true;
				}

				const openedWindow = window.open(targetUrl.toString(), '_blank', 'toolbar=no');
				return !!openedWindow;
			}
		};

		performance.mark('code/willLoadWorkbenchMain');
		create(document.body, {
			serverBasePath: '/',
			enableWorkspaceTrust: true,
			workspaceProvider,
			windowIndicator: {
				label: '$(browser)',
				tooltip: 'Code OSS Tauri Shell'
			}
		});
	</script>
</html>
"#
	.to_string()
}
