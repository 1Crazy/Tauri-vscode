/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as glob from '../../../../base/common/glob.js';
import * as paths from '../../../../base/common/path.js';
import { CancellationToken, CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { UriComponents, URI } from '../../../../base/common/uri.js';
import { ICommonQueryProps, IFileMatch, IFileQueryProps, IFolderQuery, IPatternInfo, ITextQueryProps } from '../common/search.js';
import { ILocalFileSearchWorker, IWorkerFileSearchComplete, IWorkerFileSystemDirectoryHandle, IWorkerFileSystemFileHandle, IWorkerFileSystemHandle, IWorkerTextSearchComplete, LocalFileSearchWorkerHost } from '../common/localFileSearchWorkerTypes.js';
import { getFileResults } from '../common/getFileResults.js';
import { IgnoreFile } from '../common/ignoreFile.js';
import { createRegExp } from '../../../../base/common/strings.js';
import { Promises } from '../../../../base/common/async.js';
import { ExtUri } from '../../../../base/common/resources.js';
import { revive } from '../../../../base/common/marshalling.js';

const PERF = false;

type FileNode = {
	type: 'file';
	name: string;
	path: string;
	resolve: () => Promise<ArrayBuffer>;
};

type DirNode = {
	type: 'dir';
	name: string;
	entries: Promise<(DirNode | FileNode)[]>;
};

const globalStart = +new Date();
const itrcount: Record<string, number> = {};
const time = async <T>(name: string, task: () => Promise<T> | T) => {
	if (!PERF) {
		return task();
	}

	const start = Date.now();
	const itr = (itrcount[name] ?? 0) + 1;
	console.info(name, itr, 'starting', Math.round((start - globalStart) * 10) / 10000);

	itrcount[name] = itr;
	const result = await task();
	const end = Date.now();
	console.info(name, itr, 'took', end - start);
	return result;
};

export class LocalFileSearchWorker implements ILocalFileSearchWorker {
	_requestHandlerBrand: void = undefined;

	private readonly host: LocalFileSearchWorkerHost;
	private readonly cancellationTokens = new Map<number, CancellationTokenSource>();

	constructor(host: LocalFileSearchWorkerHost) {
		this.host = host;
	}

	$cancelQuery(queryId: number): void {
		this.cancellationTokens.get(queryId)?.cancel();
	}

	private registerCancellationToken(queryId: number): CancellationTokenSource {
		const source = new CancellationTokenSource();
		this.cancellationTokens.set(queryId, source);
		return source;
	}

	async $listDirectory(handle: IWorkerFileSystemDirectoryHandle, query: IFileQueryProps<UriComponents>, folderQuery: IFolderQuery<UriComponents>, ignorePathCasing: boolean, queryId: number): Promise<IWorkerFileSearchComplete> {
		const revivedFolderQuery = reviveFolderQuery(folderQuery);
		const extUri = new ExtUri(() => ignorePathCasing);

		const token = this.registerCancellationToken(queryId);
		const entries: string[] = [];
		let limitHit = false;
		let count = 0;

		const max = query.maxResults || 512;

		const filePatternMatcher = query.filePattern
			? (name: string) => query.filePattern!.split('').every(char => name.includes(char))
			: (_name: string) => true;

		await time('listDirectory', () => this.walkFolderQuery(handle, reviveQueryProps(query), revivedFolderQuery, extUri, file => {
			if (!filePatternMatcher(file.name)) {
				return;
			}

			count++;

			if (max && count > max) {
				limitHit = true;
				token.cancel();
			}

			return entries.push(file.path);
		}, token.token));

		return {
			results: entries,
			limitHit
		};
	}

	async $searchDirectory(handle: IWorkerFileSystemDirectoryHandle, query: ITextQueryProps<UriComponents>, folderQuery: IFolderQuery<UriComponents>, ignorePathCasing: boolean, queryId: number): Promise<IWorkerTextSearchComplete> {
		const revivedQuery = reviveFolderQuery(folderQuery);
		const extUri = new ExtUri(() => ignorePathCasing);

		return time('searchInFiles', async () => {
			const token = this.registerCancellationToken(queryId);
			const results: IFileMatch[] = [];
			const pattern = createSearchRegExp(query.contentPattern);
			const onGoingProcesses: Promise<void>[] = [];

			let fileCount = 0;
			let resultCount = 0;
			const limitHit = false;

			const processFile = async (file: FileNode) => {
				if (token.token.isCancellationRequested) {
					return;
				}

				fileCount++;

				const contents = await file.resolve();
				if (token.token.isCancellationRequested) {
					return;
				}

				const bytes = new Uint8Array(contents);
				const fileResults = getFileResults(bytes, pattern, {
					surroundingContext: query.surroundingContext ?? 0,
					previewOptions: query.previewOptions,
					remainingResultQuota: query.maxResults ? (query.maxResults - resultCount) : 10000,
				});

				if (fileResults.length) {
					resultCount += fileResults.length;
					if (query.maxResults && resultCount > query.maxResults) {
						token.cancel();
					}

					const match = {
						resource: URI.joinPath(revivedQuery.folder, file.path),
						results: fileResults,
					};

					this.host.$sendTextSearchMatch(match, queryId);
					results.push(match);
				}
			};

			await time('walkFolderToResolve', () =>
				this.walkFolderQuery(handle, reviveQueryProps(query), revivedQuery, extUri, async file => onGoingProcesses.push(processFile(file)), token.token)
			);

			await time('resolveOngoingProcesses', () => Promise.all(onGoingProcesses));

			if (PERF) {
				console.log('Searched in', fileCount, 'files');
			}

			return {
				results,
				limitHit,
			};
		});
	}

	private async walkFolderQuery(handle: IWorkerFileSystemDirectoryHandle, queryProps: ICommonQueryProps<URI>, folderQuery: IFolderQuery<URI>, extUri: ExtUri, onFile: (file: FileNode) => Promise<unknown> | unknown, token: CancellationToken): Promise<void> {
		const ignoreGlobCase = queryProps.ignoreGlobCase || folderQuery.ignoreGlobCase;
		const globOptions = { trimForExclusions: true, ignoreCase: ignoreGlobCase };
		const folderExcludes = folderQuery.excludePattern?.map(excludePattern => glob.parse(excludePattern.pattern ?? {}, globOptions) as glob.ParsedExpression);

		const evalFolderExcludes = (path: string, basename: string, hasSibling: (query: string) => boolean) => {
			return folderExcludes?.some(folderExclude => folderExclude(path, basename, hasSibling));
		};

		const isFolderExcluded = (path: string, basename: string, hasSibling: (query: string) => boolean) => {
			path = path.slice(1);
			if (evalFolderExcludes(path, basename, hasSibling)) {
				return true;
			}
			if (pathExcludedInQuery(queryProps, path)) {
				return true;
			}
			return false;
		};

		const isFileIncluded = (path: string, basename: string, hasSibling: (query: string) => boolean) => {
			path = path.slice(1);
			if (evalFolderExcludes(path, basename, hasSibling)) {
				return false;
			}
			if (!pathIncludedInQuery(queryProps, path, extUri)) {
				return false;
			}
			return true;
		};

		const processFile = (file: IWorkerFileSystemFileHandle, prior: string): FileNode => {
			return {
				type: 'file',
				name: file.name,
				path: prior,
				resolve: () => file.getFile().then(result => result.arrayBuffer())
			};
		};

		const isFileSystemDirectoryHandle = (entryHandle: IWorkerFileSystemHandle): entryHandle is IWorkerFileSystemDirectoryHandle => {
			return entryHandle.kind === 'directory';
		};

		const isFileSystemFileHandle = (entryHandle: IWorkerFileSystemHandle): entryHandle is IWorkerFileSystemFileHandle => {
			return entryHandle.kind === 'file';
		};

		const processDirectory = async (directory: IWorkerFileSystemDirectoryHandle, prior: string, ignoreFile?: IgnoreFile): Promise<DirNode> => {
			if (!folderQuery.disregardIgnoreFiles) {
				const ignoreFiles = await Promise.all([
					directory.getFileHandle('.gitignore').catch(() => undefined),
					directory.getFileHandle('.ignore').catch(() => undefined),
				]);

				await Promise.all(ignoreFiles.map(async file => {
					if (!file) {
						return;
					}

					const ignoreContents = new TextDecoder('utf8').decode(new Uint8Array(await (await file.getFile()).arrayBuffer()));
					ignoreFile = new IgnoreFile(ignoreContents, prior, ignoreFile, ignoreGlobCase);
				}));
			}

			const entries = Promises.withAsyncBody<(FileNode | DirNode)[]>(async complete => {
				const files: FileNode[] = [];
				const dirs: Promise<DirNode>[] = [];
				const directoryEntries: [string, IWorkerFileSystemHandle][] = [];
				const siblings = new Set<string>();

				for await (const entry of directory.entries()) {
					directoryEntries.push(entry);
					siblings.add(entry[0]);
				}

				for (const [basename, entryHandle] of directoryEntries) {
					if (token.isCancellationRequested) {
						break;
					}

					const path = prior + basename;

					if (ignoreFile && !ignoreFile.isPathIncludedInTraversal(path, entryHandle.kind === 'directory')) {
						continue;
					}

					const hasSibling = (query: string) => siblings.has(query);

					if (isFileSystemDirectoryHandle(entryHandle) && !isFolderExcluded(path, basename, hasSibling)) {
						dirs.push(processDirectory(entryHandle, `${path}/`, ignoreFile));
					} else if (isFileSystemFileHandle(entryHandle) && isFileIncluded(path, basename, hasSibling)) {
						files.push(processFile(entryHandle, path));
					}
				}

				complete([...await Promise.all(dirs), ...files]);
			});

			return {
				type: 'dir',
				name: directory.name,
				entries
			};
		};

		const resolveDirectory = async (directory: DirNode, onFileCallback: (file: FileNode) => Promise<unknown> | unknown) => {
			if (token.isCancellationRequested) {
				return;
			}

			await Promise.all(
				(await directory.entries)
					.sort((left, right) => -(left.type === 'dir' ? 0 : 1) + (right.type === 'dir' ? 0 : 1))
					.map(async entry => {
						if (entry.type === 'dir') {
							return resolveDirectory(entry, onFileCallback);
						}

						return onFileCallback(entry);
					})
			);
		};

		const processed = await time('process', () => processDirectory(handle, '/'));
		await time('resolve', () => resolveDirectory(processed, onFile));
	}
}

function createSearchRegExp(options: IPatternInfo): RegExp {
	return createRegExp(options.pattern, !!options.isRegExp, {
		wholeWord: options.isWordMatch,
		global: true,
		matchCase: options.isCaseSensitive,
		multiline: true,
		unicode: true,
	});
}

function reviveFolderQuery(folderQuery: IFolderQuery<UriComponents>): IFolderQuery<URI> {
	return revive({
		...revive(folderQuery),
		excludePattern: folderQuery.excludePattern?.map(ep => ({ folder: URI.revive(ep.folder), pattern: ep.pattern })),
		folder: URI.revive(folderQuery.folder),
	});
}

function reviveQueryProps(queryProps: ICommonQueryProps<UriComponents>): ICommonQueryProps<URI> {
	return {
		...queryProps,
		extraFileResources: queryProps.extraFileResources?.map(resource => URI.revive(resource)),
		folderQueries: queryProps.folderQueries.map(folderQuery => reviveFolderQuery(folderQuery)),
	};
}

function pathExcludedInQuery(queryProps: ICommonQueryProps<URI>, fsPath: string): boolean {
	const globOptions = queryProps.ignoreGlobCase ? { ignoreCase: true } : undefined;
	if (queryProps.excludePattern && glob.match(queryProps.excludePattern, fsPath, globOptions)) {
		return true;
	}
	return false;
}

function pathIncludedInQuery(queryProps: ICommonQueryProps<URI>, path: string, extUri: ExtUri): boolean {
	const globOptions = queryProps.ignoreGlobCase ? { ignoreCase: true } : undefined;
	if (queryProps.excludePattern && glob.match(queryProps.excludePattern, path, globOptions)) {
		return false;
	}

	if (queryProps.includePattern || queryProps.usingSearchPaths) {
		if (queryProps.includePattern && glob.match(queryProps.includePattern, path, globOptions)) {
			return true;
		}

		if (queryProps.usingSearchPaths) {
			return !!queryProps.folderQueries && queryProps.folderQueries.some(folderQuery => {
				const searchPath = folderQuery.folder;
				const resource = URI.file(path);
				if (extUri.isEqualOrParent(resource, searchPath)) {
					const relativePath = paths.relative(searchPath.path, resource.path);
					return !folderQuery.includePattern || !!glob.match(folderQuery.includePattern, relativePath, globOptions);
				}

				return false;
			});
		}

		return false;
	}

	return true;
}
