/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

const cp = require('child_process');
const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..');
const tauriRoot = path.join(repoRoot, 'tauri-shell', 'src-tauri');
const bundleOutputDir = path.join(tauriRoot, 'target', 'release', 'bundle');
const bundledResourcesDir = path.join(tauriRoot, 'bundled');
const bundledWebDir = path.join(bundledResourcesDir, 'vscode-web');
const bundledWebResourcesDir = path.join(bundledWebDir, 'resources', 'server');
const bundledWebOutDir = path.join(bundledWebDir, 'out');
const bundledWebExtensionsDir = path.join(bundledWebDir, 'extensions');
const bundledWebNodeModulesDir = path.join(bundledWebDir, 'node_modules');
const tauriIconSourcePath = path.join(tauriRoot, 'icons', 'icon.png');
const tauriMacIconPath = path.join(tauriRoot, 'icons', 'icon.icns');
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const standaloneWebOutDir = path.join(repoRoot, 'out-vscode-web-min');
const standaloneWebExtensionsDir = path.join(repoRoot, '.build', 'web', 'extensions');
const standaloneWebNodeModulesDir = path.join(repoRoot, 'remote', 'web', 'node_modules');
const standaloneWebServerResourcesDir = path.join(repoRoot, 'resources', 'server');
const bundledWebGitignorePath = path.join(bundledWebDir, '.gitignore');
const standaloneWebBundleScriptPath = path.join(repoRoot, 'build', 'next', 'index.ts');

// Windows runners expose npm as npm.cmd, and spawnSync cannot execute .cmd
// files directly without a shell. Keep the shell opt-in narrowly scoped so
// Unix builds still execute binaries directly.
function shouldUseShell(command) {
	return process.platform === 'win32' && /\.(cmd|bat)$/i.test(path.basename(command));
}

function printHelp() {
	console.log(
		[
			'Usage:',
			'  npm run desktop-rust-build',
			'  npm run desktop-rust-build -- --skip-compile',
			'  npm run desktop-rust-build -- --debug',
			'',
			'What it does:',
			'  1. build the standalone VS Code web assets for distribution',
			'  2. stage them into tauri-shell/src-tauri/bundled/vscode-web',
			'  3. run `cargo tauri build` in tauri-shell/src-tauri',
			'',
			'Notes:',
			'  - release bundles embed the standalone web assets instead of depending on the local repo checkout',
			'  - install `cargo-tauri` first if it is not available: cargo install tauri-cli --version "^2"'
		].join('\n')
	);
}

function fail(message) {
	console.error(`\n[desktop-rust-build] ${message}`);
	process.exit(1);
}

function run(command, args, options = {}) {
	const cwd = options.cwd ?? repoRoot;
	const env = options.env ?? process.env;
	const shell = options.shell ?? shouldUseShell(command);

	console.log(`\n> ${command} ${args.join(' ')}`);

	const result = cp.spawnSync(command, args, {
		cwd,
		env,
		stdio: 'inherit',
		shell
	});

	if (result.error) {
		fail(result.error.message);
	}

	if (typeof result.status === 'number' && result.status !== 0) {
		process.exit(result.status);
	}
}

function hasCargoTauri() {
	const result = cp.spawnSync('cargo', ['tauri', '--version'], {
		cwd: repoRoot,
		encoding: 'utf8',
		stdio: 'pipe'
	});

	return result.status === 0;
}

function parseArgs(argv) {
	const options = {
		skipCompile: false,
		tauriArgs: []
	};

	for (const arg of argv) {
		if (arg === '--help' || arg === '-h') {
			printHelp();
			process.exit(0);
		}

		if (arg === '--skip-compile') {
			options.skipCompile = true;
			continue;
		}

		options.tauriArgs.push(arg);
	}

	return options;
}

function ensurePaths() {
	const tauriConfigPath = path.join(tauriRoot, 'tauri.conf.json');
	if (!fs.existsSync(tauriConfigPath)) {
		fail(`Missing Tauri config: ${tauriConfigPath}`);
	}

	if (!fs.existsSync(tauriIconSourcePath)) {
		fail(`Missing source icon: ${tauriIconSourcePath}`);
	}

	if (!fs.existsSync(standaloneWebBundleScriptPath)) {
		fail(`Missing standalone web bundler: ${standaloneWebBundleScriptPath}`);
	}
}

function ensureDirectory(dirPath) {
	fs.mkdirSync(dirPath, { recursive: true });
}

function resetDirectory(dirPath) {
	fs.rmSync(dirPath, { recursive: true, force: true });
	ensureDirectory(dirPath);
}

function copyDirectory(source, target) {
	if (!fs.existsSync(source)) {
		fail(`Missing directory to bundle: ${source}`);
	}

	fs.cpSync(source, target, {
		recursive: true,
		force: true,
	});
}

function ensureBundledWebGitignore() {
	// Keep the generated bundle directory out of git while still checking in the
	// placeholder file that preserves the directory structure in fresh clones.
	fs.writeFileSync(bundledWebGitignorePath, '*\n!.gitignore\n');
}

function stageStandaloneWebBundle() {
	if (!fs.existsSync(standaloneWebOutDir)) {
		fail(`Missing standalone web output: ${standaloneWebOutDir}`);
	}

	if (!fs.existsSync(standaloneWebExtensionsDir)) {
		fail(`Missing bundled web extensions: ${standaloneWebExtensionsDir}`);
	}

	if (!fs.existsSync(standaloneWebNodeModulesDir)) {
		fail(`Missing standalone web node_modules: ${standaloneWebNodeModulesDir}`);
	}

	resetDirectory(bundledWebDir);
	copyDirectory(standaloneWebOutDir, bundledWebOutDir);
	copyDirectory(standaloneWebExtensionsDir, bundledWebExtensionsDir);
	copyDirectory(standaloneWebNodeModulesDir, bundledWebNodeModulesDir);
	copyDirectory(standaloneWebServerResourcesDir, bundledWebResourcesDir);
	ensureBundledWebGitignore();
}

function ensureTauriIcons() {
	if (fs.existsSync(tauriMacIconPath)) {
		return;
	}

	run('cargo', ['tauri', 'icon', tauriIconSourcePath, '--output', path.join(tauriRoot, 'icons')], {
		cwd: repoRoot
	});
}

function buildStandaloneWebAssets(env) {
	run(npmCommand, ['run', 'gulp', 'copy-codicons'], { env });
	run(npmCommand, ['run', 'gulp', 'compile-web-extensions-build'], { env });

	// The esbuild-based web bundle exists in build/gulpfile.vscode.web.ts, but
	// that helper task is not registered as a standalone gulp CLI target in this
	// repo snapshot. Call the underlying bundler entrypoint directly so CI stays
	// stable across platforms instead of depending on gulp task registration.
	run(process.execPath, [
		standaloneWebBundleScriptPath,
		'bundle',
		'--out', path.relative(repoRoot, standaloneWebOutDir),
		'--target', 'web',
		'--minify',
		'--mangle-privates',
		'--nls'
	], { env });
}

function main() {
	const { skipCompile, tauriArgs } = parseArgs(process.argv.slice(2));

	ensurePaths();

	if (!hasCargoTauri()) {
		fail('Missing `cargo tauri`. Install it with: cargo install tauri-cli --version "^2"');
	}

	const env = {
		...process.env,
		NODE_BINARY: process.execPath,
		TAURI_SHELL_NODE_BINARY: process.execPath,
		TAURI_SHELL_REPO_ROOT: repoRoot
	};

	ensureTauriIcons();

	if (!skipCompile) {
		buildStandaloneWebAssets(env);
	}

	stageStandaloneWebBundle();
	run('cargo', ['tauri', 'build', ...tauriArgs], { cwd: tauriRoot, env });

	console.log(`\n[desktop-rust-build] Bundle output: ${bundleOutputDir}`);
	console.log(`[desktop-rust-build] Embedded web assets: ${bundledWebDir}`);
}

main();
