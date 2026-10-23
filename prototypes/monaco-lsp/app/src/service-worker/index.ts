/**
 * Makes the app work offline and cross-origin isolated.
 *
 * Offline: when this worker installs, it precaches the app shell, the files
 * the app needs to start, as `offline.json` lists them (written at build
 * time, scripts/offline-manifest.mjs). Everything else is cached the first
 * time it is fetched: the app's lazy files (Monaco's HTML, CSS and JSON
 * services and their workers, grammars, schemas) in this build's app cache,
 * a language pack's files in the pack cache. The page's Download everything
 * fills the same caches ahead of time (offline.svelte.ts). The cache names
 * and the manifest's shape are in src/lib/offline-cache.ts.
 *
 * Until this build, the install precached every file of `static/`, which
 * includes every pack and its .br and .gz copies: a first visit downloaded
 * some 400 MB in the background. A path relative to the root never starts
 * with `/packs/`, which is what the filter looked for.
 *
 * Updates: a new build's worker installs, then waits; the page offers a
 * reload (pwa.ts), which sends `skip-waiting`. Activating drops the old
 * app cache, and the pack files the new build changed.
 *
 * Isolation: some language servers block on a `SharedArrayBuffer`, which a
 * page may only use when it is served with COOP and COEP headers. A static
 * host often cannot send headers, so every same-origin response this worker
 * hands out carries them. Everything the app loads is same-origin, so
 * `require-corp` costs nothing.
 */
import { assets, immutable, prerendered } from '$app/manifest';
import { version } from '$app/env';
import { self as sw } from '$app/service-worker';
import { appCacheName, DIRECT_HEADER, HASH_HEADER, isOfflineManifest, isPackPath, MANIFEST_PATH, PACKS_CACHE, storable, type OfflineFile, type OfflineManifest } from '../lib/offline-cache';

const APP = appCacheName(version);
/** A path relative to the app's root (this worker's scope) as a URL. */
const url = (path: string) => new URL(path.replace(/^\//, ''), sw.registration.scope).href;
/** A same-origin URL as a path relative to the app's root, or null outside the scope. */
const pathOf = (href: string) => (href.startsWith(sw.registration.scope) ? href.slice(sw.registration.scope.length).split(/[?#]/)[0]! : null);

/** This build's manifest, read once from the app cache (where install put it). */
let manifest: Promise<OfflineManifest | null> | null = null;
function loadManifest(): Promise<OfflineManifest | null> {
	manifest ??= caches
		.open(APP)
		.then((cache) => cache.match(url(MANIFEST_PATH)))
		.then((r) => r?.json() as Promise<unknown> | undefined)
		.then((m) => (isOfflineManifest(m) && m.version === version ? m : null))
		.catch(() => null);
	return manifest;
}

/** Pack files by path, from the manifest. */
async function packFiles(): Promise<Map<string, OfflineFile>> {
	const m = await loadManifest();
	return new Map(Object.values(m?.packs ?? {}).flatMap((files) => files.map((f) => [f.path, f] as const)));
}

/**
 * The shell: the manifest's when it is this build's. A host may serve the
 * new worker with an older offline.json (a deploy in progress); then every
 * app file but the packs is precached, as before there was a manifest.
 */
async function shellPaths(): Promise<string[]> {
	try {
		const response = await fetch(url(MANIFEST_PATH), { cache: 'no-cache' });
		const m: unknown = await response.clone().json();
		if (response.ok && isOfflineManifest(m) && m.version === version) {
			await (await caches.open(APP)).put(url(MANIFEST_PATH), response);
			return m.shell.map((f) => f.path);
		}
	} catch {
		// No manifest: the fallback below.
	}
	return [...immutable, ...prerendered, ...assets].map((f) => f.path.replace(/^\//, '')).filter((p) => !isPackPath(p) && !/\.(br|gz)$/.test(p));
}

sw.addEventListener('install', (event) => {
	event.waitUntil(
		(async () => {
			const cache = await caches.open(APP);
			const paths = await shellPaths();
			// Hashed files are the same bytes whenever fetched, so the copy the
			// page just downloaded (in the HTTP cache) will do.
			await Promise.all(paths.map((p) => cache.add(new Request(url(p), { cache: p.startsWith('_app/immutable/') ? 'force-cache' : 'no-cache' }))));
		})(),
		// No skipWaiting here: a new build waits until the page asks (pwa.ts),
		// so an open tab never loses the cached files of the build it runs.
	);
});

sw.addEventListener('activate', (event) => {
	event.waitUntil(
		(async () => {
			await Promise.all((await caches.keys()).filter((k) => k !== APP && k !== PACKS_CACHE).map((k) => caches.delete(k)));
			// Keep only the pack files this build lists with the same hash.
			const files = await packFiles();
			if (files.size) {
				const packs = await caches.open(PACKS_CACHE);
				for (const request of await packs.keys()) {
					const path = pathOf(request.url);
					const cached = await packs.match(request);
					if (!path || !cached || files.get(path)?.hash !== cached.headers.get(HASH_HEADER)) await packs.delete(request);
				}
			}
			await sw.clients.claim();
		})(),
	);
});

sw.addEventListener('message', (event) => {
	if (event.data === 'skip-waiting') void sw.skipWaiting();
});

/** A copy of a response with the isolation headers added. Opaque and error responses pass unchanged. */
function isolated(response: Response): Response {
	if (response.type === 'opaque' || response.type === 'opaqueredirect' || response.status === 0) return response;
	const headers = new Headers(response.headers);
	headers.set('Cross-Origin-Opener-Policy', 'same-origin');
	headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
	headers.set('Cross-Origin-Resource-Policy', 'same-origin');
	return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function respond(request: Request, event: FetchEvent): Promise<Response> {
	const path = pathOf(request.url);
	const app = await caches.open(APP);
	// Pages: the network when it answers, so a new build is picked up; the cache offline.
	if (request.mode === 'navigate') {
		try {
			return await fetch(request);
		} catch {
			return (await app.match(request, { ignoreSearch: true })) ?? (await app.match(url(''))) ?? Response.error();
		}
	}
	if (path === null) return fetch(request);
	// The page caches this one itself (Download everything).
	if (request.headers.has(DIRECT_HEADER)) return fetch(request);
	const cache = isPackPath(path) ? await caches.open(PACKS_CACHE) : app;
	const cached = await cache.match(request, { ignoreSearch: !isPackPath(path) });
	if (cached) return cached;
	const response = await fetch(request);
	// Cache pack files and the app's own files (not, say, a preview's
	// requests); hand the response over at once, so a pack sees its download
	// progress, and let the copy go into the cache alongside.
	const appFile = path.startsWith('_app/') || path.startsWith('schemas/');
	if (response.ok && response.status === 200 && (isPackPath(path) || appFile)) {
		const file = isPackPath(path) ? (await packFiles()).get(path) : undefined;
		event.waitUntil(cache.put(request.url, storable(response.clone(), file)));
	}
	return response;
}

sw.addEventListener('fetch', (event) => {
	const { request } = event;
	if (request.method !== 'GET' || new URL(request.url).origin !== sw.location.origin) return;
	event.respondWith(respond(request, event).then(isolated));
});
