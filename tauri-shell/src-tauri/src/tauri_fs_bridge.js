//---------------------------------------------------------------------------------------------
//  Copyright (c) Microsoft Corporation. All rights reserved.
//  Licensed under the MIT License. See License.txt in the project root for license information.
//---------------------------------------------------------------------------------------------

(function () {
	const globalObject = window;
	const bridgeKey = '__code_oss_tauri_file_system_bridge__';
	if (bridgeKey in globalObject) {
		return;
	}

	const tauriInvoke = globalObject.__TAURI_INTERNALS__ && globalObject.__TAURI_INTERNALS__.invoke;
	if (typeof tauriInvoke !== 'function') {
		return;
	}

	const persistedHandleMarker = 'tauri-shell';

	function createAbortError() {
		return new DOMException('The user aborted a request.', 'AbortError');
	}

	function toPersistedDescriptor(descriptor) {
		return {
			$vscodeTauriHandle: persistedHandleMarker,
			kind: descriptor.kind,
			name: descriptor.name,
			path: descriptor.path
		};
	}

	function isPersistedDescriptor(value) {
		return !!value &&
			value.$vscodeTauriHandle === persistedHandleMarker &&
			(value.kind === 'file' || value.kind === 'directory') &&
			typeof value.name === 'string' &&
			typeof value.path === 'string';
	}

	function isExpectedLookupMiss(command, error) {
		if (command !== 'tauri_shell_get_file_handle' && command !== 'tauri_shell_get_directory_handle') {
			return false;
		}

		const message = error instanceof Error ? error.message : String(error);
		return message.includes('No such file or directory') || message.includes('os error 2');
	}

	function invoke(command, payload) {
		return Promise.resolve(typeof payload === 'undefined' ? tauriInvoke(command) : tauriInvoke(command, payload)).catch(error => {
			if (!isExpectedLookupMiss(command, error)) {
				console.error('[tauri-fs] invoke failed', command, payload, error);
			}
			throw error;
		});
	}

	function normalizeBytes(data) {
		if (data instanceof Uint8Array) {
			return data;
		}

		if (data instanceof ArrayBuffer) {
			return new Uint8Array(data);
		}

		if (ArrayBuffer.isView(data)) {
			return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
		}

		if (typeof data === 'string') {
			return new TextEncoder().encode(data);
		}

		if (data && typeof data === 'object' && 'type' in data && data.type === 'write') {
			return normalizeBytes(data.data);
		}

		throw new TypeError('Unsupported writable data type.');
	}

	class TauriFileSystemHandle {
		constructor(descriptor) {
			this.kind = descriptor.kind;
			this.name = descriptor.name;
			Object.defineProperty(this, '__descriptor', {
				configurable: false,
				enumerable: false,
				value: descriptor,
				writable: false
			});
		}

		async queryPermission() {
			return 'granted';
		}

		async requestPermission() {
			return 'granted';
		}

		async isSameEntry(other) {
			return isTauriHandle(other) &&
				other.__descriptor.kind === this.__descriptor.kind &&
				other.__descriptor.path === this.__descriptor.path;
		}
	}

	class TauriFileSystemFileHandle extends TauriFileSystemHandle {
		constructor(descriptor) {
			super(descriptor);
			this.kind = 'file';
		}

		async getFile() {
			const fileInfo = await invoke('tauri_shell_get_file', { path: this.__descriptor.path });
			const bytes = Uint8Array.from(fileInfo.data);
			return new File([bytes], fileInfo.name, { lastModified: fileInfo.lastModified });
		}

		async createWritable() {
			const descriptor = this.__descriptor;
			let pendingWrite = new Uint8Array();

			return {
				write: async data => {
					pendingWrite = normalizeBytes(data);
				},
				close: async () => {
					await invoke('tauri_shell_write_file', { path: descriptor.path, data: Array.from(pendingWrite) });
				},
				abort: async () => {
					pendingWrite = new Uint8Array();
				}
			};
		}
	}

	class TauriFileSystemDirectoryHandle extends TauriFileSystemHandle {
		constructor(descriptor) {
			super(descriptor);
			this.kind = 'directory';
		}

		async *entries() {
			const entries = await invoke('tauri_shell_list_directory', { path: this.__descriptor.path });
			console.debug('[tauri-fs] readdir', this.__descriptor.path, entries.length);
			for (const entry of entries) {
				yield [entry.name, createHandle(entry)];
			}
		}

		async *keys() {
			for await (const [name] of this.entries()) {
				yield name;
			}
		}

		async *values() {
			for await (const [, handle] of this.entries()) {
				yield handle;
			}
		}

		[Symbol.asyncIterator]() {
			return this.entries();
		}

		async getDirectoryHandle(name, options) {
			const descriptor = await invoke('tauri_shell_get_directory_handle', {
				path: this.__descriptor.path,
				name,
				create: !!options?.create
			});
			return createHandle(descriptor);
		}

		async getFileHandle(name, options) {
			const descriptor = await invoke('tauri_shell_get_file_handle', {
				path: this.__descriptor.path,
				name,
				create: !!options?.create
			});
			return createHandle(descriptor);
		}

		async removeEntry(name, options) {
			await invoke('tauri_shell_remove_entry', {
				path: this.__descriptor.path,
				name,
				recursive: !!options?.recursive
			});
		}
	}

	function createHandle(descriptor) {
		const persistedDescriptor = isPersistedDescriptor(descriptor) ? descriptor : toPersistedDescriptor(descriptor);
		if (persistedDescriptor.kind === 'file') {
			return new TauriFileSystemFileHandle(persistedDescriptor);
		}

		return new TauriFileSystemDirectoryHandle(persistedDescriptor);
	}

	function isTauriHandle(value) {
		return value instanceof TauriFileSystemHandle;
	}

	const bridge = Object.freeze({
		async pickDirectory(_options) {
			const descriptor = await invoke('tauri_shell_pick_directory');
			if (!descriptor) {
				throw createAbortError();
			}

			return createHandle(descriptor);
		},
		restoreHandle(descriptor) {
			return createHandle(descriptor);
		},
		isHandle(value) {
			return isTauriHandle(value);
		},
		toPersistedHandle(handle) {
			return isTauriHandle(handle) ? handle.__descriptor : undefined;
		}
	});

	Object.defineProperty(globalObject, bridgeKey, {
		configurable: false,
		enumerable: false,
		value: bridge,
		writable: false
	});

	if (typeof globalObject.showDirectoryPicker !== 'function') {
		Object.defineProperty(globalObject, 'showDirectoryPicker', {
			configurable: true,
			enumerable: false,
			value: options => bridge.pickDirectory(options),
			writable: true
		});
	}
})();
