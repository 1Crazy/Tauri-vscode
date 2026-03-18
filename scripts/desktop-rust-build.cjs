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
const tauriIconSourcePath = path.join(tauriRoot, 'icons', 'icon.png');
const tauriMacIconPath = path.join(tauriRoot, 'icons', 'icon.icns');
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function printHelp() {
	console.log(
		[
			'Usage:',
			'  npm run desktop-rust-build',
			'  npm run desktop-rust-build -- --skip-compile',
			'  npm run desktop-rust-build -- --debug',
			'',
			'What it does:',
			'  1. transpile the client out/ assets',
			'  2. compile the web assets',
			'  3. run `cargo tauri build` in tauri-shell/src-tauri',
			'',
			'Notes:',
			'  - this bundle currently targets the local machine and still depends on the local repo checkout',
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

	console.log(`\n> ${command} ${args.join(' ')}`);

	const result = cp.spawnSync(command, args, {
		cwd,
		env,
		stdio: 'inherit'
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
}

function ensureTauriIcons() {
	if (fs.existsSync(tauriMacIconPath)) {
		return;
	}

	run('cargo', ['tauri', 'icon', tauriIconSourcePath, '--output', path.join(tauriRoot, 'icons')], {
		cwd: repoRoot
	});
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
		run(npmCommand, ['run', 'transpile-client'], { env });
		run(npmCommand, ['run', 'compile-web'], { env });
	}

	run('cargo', ['tauri', 'build', ...tauriArgs], { cwd: tauriRoot, env });

	console.log(`\n[desktop-rust-build] Bundle output: ${bundleOutputDir}`);
	console.log('[desktop-rust-build] This build currently still expects the local repo and Node runtime on this machine.');
}

main();
