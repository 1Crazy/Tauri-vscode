# Code OSS Tauri Shell

This folder contains a minimal Tauri host for the existing VS Code web workbench.

What it does today:

- Starts the repository's existing web entrypoint via `scripts/code-web.js`
- Waits for the local HTTP server to become ready
- Opens that URL inside a Tauri desktop window

What it does not do yet:

- Replace the Electron desktop implementation feature-for-feature
- Bundle a standalone Node runtime
- Re-implement Electron-native services such as update flow, menus, native dialogs, terminal hosting, or desktop-only extension behavior

Why this shape:

- The repository already ships a web workbench path via `scripts/code-web.js`
- The repository already has a dedicated standalone web bundle pipeline in `build/gulpfile.vscode.web.ts`
- Using Tauri as a host is realistic only if we treat VS Code Web as the frontend and migrate native integrations incrementally

Expected prerequisites:

- Rust toolchain installed and `cargo` available
- Root JavaScript dependencies installed in the repository
- Platform-specific WebView prerequisites satisfied for Tauri

Run flow once prerequisites are installed:

1. Install repository dependencies at the repo root.
2. Change into `tauri-shell/src-tauri`.
3. Run `cargo run`.

Environment overrides:

- `NODE_BINARY`: optional path to the Node.js executable used to launch `scripts/code-web.js`

Notes:

- The current implementation runs against the source-based web server for the repo.
- A later phase can switch the Tauri host to a packaged `vscode-web` artifact for a more self-contained desktop build.
