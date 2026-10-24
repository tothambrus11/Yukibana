/**
 * What the service worker and the page agree on about the offline caches:
 * the names of the caches, the shape of `offline.json` (written at build
 * time by scripts/offline-manifest.mjs) and how a response is stored. Both
 * the worker (src/service-worker) and the page (offline.svelte.ts) import
 * this, so neither can drift from the other. No DOM: the worker has none.
 */

/** One file the app can fetch, by its path relative to the app's root (`''` is the page). */
export interface OfflineFile {
	path: string;
	/** Bytes on disk, uncompressed: what a cache stores. */
	size: number;
	/** Bytes over the network: the brotli sibling's size when there is one. */
	transfer: number;
	/** A content hash, for pack files only: a cached copy is kept while it matches. */
	hash?: string;
}

/** `offline.json`, the build's list of every file it can serve. */
export interface OfflineManifest {
	/** The build's version, as `$app/env` has it; the service worker of another build ignores this file. */
	version: string;
	/** What the app needs to start: precached when the service worker installs. */
	shell: OfflineFile[];
	/** App files fetched only when a language needs them (Monaco's language services, grammars, schemas). */
	lazy: OfflineFile[];
	/** Each pack's files, by pack directory. */
	packs: Record<string, OfflineFile[]>;
}

/** Where the manifest is, relative to the app's root. */
export const MANIFEST_PATH = 'offline.json';

/**
 * The cache of one build's app files, shell and lazy. A new build gets a
 * new one and the old one is dropped when it activates: its file names are
 * content hashed, so nothing in it could be reused anyway.
 */
export const appCacheName = (version: string): string => `app-${version}`;

/**
 * The cache of pack files, kept across builds: a pack file is hundreds of
 * megabytes at worst, and most app updates change none of them. A new build
 * removes only the entries whose hash it does not list (see `HASH_HEADER`).
 * Before this, each build had its own `packs-<version>` cache, and every
 * update threw every downloaded language away.
 */
export const PACKS_CACHE = 'packs';

/** The header a cached pack file carries its manifest hash in. */
export const HASH_HEADER = 'X-Yukibana-Hash';

/**
 * Sent by the page on a request it caches itself (Download everything), so
 * the service worker passes it to the network instead of caching a second
 * copy: the page needs the bytes as they arrive, for its progress bar.
 */
export const DIRECT_HEADER = 'X-Yukibana-Direct';

/** Whether a path (relative to the app's root) is a pack file. */
export const isPackPath = (path: string): boolean => path.startsWith('packs/');

/**
 * A response as it goes into a cache: the body as fetched, already decoded,
 * so without the Content-Encoding, Content-Length and Vary of the encoded
 * bytes. A pack file (`file`, its manifest entry) also gets its hash and,
 * as Content-Length, its decoded size, which a pack's download progress
 * reads as the total.
 */
export function storable(response: Response, file: OfflineFile | undefined): Response {
	const headers = new Headers(response.headers);
	headers.delete('Content-Encoding');
	headers.delete('Content-Length');
	headers.delete('Vary');
	if (file?.hash) {
		headers.set(HASH_HEADER, file.hash);
		headers.set('Content-Length', String(file.size));
	}
	return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/** Narrows parsed `offline.json` to its shape; anything else is not a manifest. */
export function isOfflineManifest(value: unknown): value is OfflineManifest {
	const isFiles = (files: unknown): files is OfflineFile[] =>
		Array.isArray(files) && files.every((f: unknown) => typeof f === 'object' && f !== null && typeof (f as OfflineFile).path === 'string' && typeof (f as OfflineFile).size === 'number' && typeof (f as OfflineFile).transfer === 'number');
	if (typeof value !== 'object' || value === null) return false;
	const m = value as Partial<OfflineManifest>;
	return typeof m.version === 'string' && isFiles(m.shell) && isFiles(m.lazy) && typeof m.packs === 'object' && m.packs !== null && Object.values(m.packs).every(isFiles);
}
