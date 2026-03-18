/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

const fs = require('fs');
const path = require('path');
const Module = require('module');

function isWebExtension(manifest) {
	if (Boolean(manifest.browser)) {
		return true;
	}
	if (Boolean(manifest.main)) {
		return false;
	}
	if (typeof manifest.extensionKind !== 'undefined') {
		const extensionKind = Array.isArray(manifest.extensionKind) ? manifest.extensionKind : [manifest.extensionKind];
		if (extensionKind.indexOf('web') >= 0) {
			return true;
		}
	}
	if (typeof manifest.contributes !== 'undefined') {
		for (const id of ['debuggers', 'terminal', 'typescriptServerPlugins']) {
			if (Object.prototype.hasOwnProperty.call(manifest.contributes, id)) {
				return false;
			}
		}
	}
	return true;
}

function scanBuiltinExtensions(extensionsRoot, exclude = []) {
	const scannedExtensions = [];

	try {
		const extensionFolders = fs.readdirSync(extensionsRoot);
		for (const extensionFolder of extensionFolders) {
			if (exclude.includes(extensionFolder)) {
				continue;
			}

			const extensionFolderPath = path.join(extensionsRoot, extensionFolder);
			const packageJSONPath = path.join(extensionFolderPath, 'package.json');
			if (!fs.existsSync(packageJSONPath)) {
				continue;
			}

			try {
				const packageJSON = JSON.parse(fs.readFileSync(packageJSONPath, 'utf8'));
				if (!isWebExtension(packageJSON)) {
					continue;
				}

				const children = fs.readdirSync(extensionFolderPath);
				const packageNLSPath = children.find(child => child === 'package.nls.json');
				const readme = children.find(child => /^readme(\.txt|\.md|)$/i.test(child));
				const changelog = children.find(child => /^changelog(\.txt|\.md|)$/i.test(child));

				scannedExtensions.push({
					extensionPath: extensionFolder,
					packageJSON,
					packageNLS: packageNLSPath ? JSON.parse(fs.readFileSync(path.join(extensionFolderPath, packageNLSPath), 'utf8')) : undefined,
					readmePath: readme ? path.join(extensionFolder, readme) : undefined,
					changelogPath: changelog ? path.join(extensionFolder, changelog) : undefined
				});
			} catch {
				// Skip invalid extension folders so the dev server can still boot.
			}
		}
	} catch {
		// Ignore missing roots and let the caller continue with an empty extension set.
	}

	return scannedExtensions;
}

const extensionsShim = {
	isWebExtension,
	scanBuiltinExtensions
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
	if (typeof request === 'string') {
		const normalizedRequest = request.replace(/\\/g, '/');
		if (normalizedRequest.endsWith('/build/lib/extensions.ts') || normalizedRequest.endsWith('/build/lib/extensions.js')) {
			return extensionsShim;
		}
	}

	return originalLoad.call(this, request, parent, isMain);
};
