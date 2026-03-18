/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

const TAURI_FILE_SYSTEM_BRIDGE_KEY = '__code_oss_tauri_file_system_bridge__';
const TAURI_FILE_SYSTEM_HANDLE_MARKER = 'tauri-shell';

export interface ITauriPersistedFileSystemHandle {
	readonly $vscodeTauriHandle: typeof TAURI_FILE_SYSTEM_HANDLE_MARKER;
	readonly kind: FileSystemHandleKind;
	readonly name: string;
	readonly path: string;
}

export interface ITauriFileSystemBridge {
	pickDirectory(options?: { title?: string }): Promise<FileSystemDirectoryHandle>;
	restoreHandle(descriptor: ITauriPersistedFileSystemHandle): FileSystemHandle;
	isHandle(handle: unknown): handle is FileSystemHandle;
	toPersistedHandle(handle: FileSystemHandle): ITauriPersistedFileSystemHandle | undefined;
}

type ITauriFileSystemBridgeGlobal = typeof globalThis & {
	__code_oss_tauri_file_system_bridge__?: ITauriFileSystemBridge;
};

export function getTauriFileSystemBridge(obj: typeof globalThis = globalThis): ITauriFileSystemBridge | undefined {
	return (obj as ITauriFileSystemBridgeGlobal)[TAURI_FILE_SYSTEM_BRIDGE_KEY];
}

export function isTauriFileSystemBridgeAvailable(obj: typeof globalThis = globalThis): boolean {
	return !!getTauriFileSystemBridge(obj);
}

export function isTauriPersistedFileSystemHandle(value: unknown): value is ITauriPersistedFileSystemHandle {
	const candidate = value as ITauriPersistedFileSystemHandle | undefined;

	return candidate?.$vscodeTauriHandle === TAURI_FILE_SYSTEM_HANDLE_MARKER &&
		(candidate.kind === 'file' || candidate.kind === 'directory') &&
		typeof candidate.name === 'string' &&
		typeof candidate.path === 'string';
}
