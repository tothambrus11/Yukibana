/**
 * Makes the app work offline and cross-origin isolated.
 *
 * Offline: the app shell is cached when the worker installs; a language
 * pack's files are cached the first time they are fetched, so a language
 * used once works without a network afterwards. Both caches are named by
 * the build's version and dropped when a new build activates.
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

const SHELL = `shell-${version}`;
const PACKS = `packs-${version}`;
const isPack = (path: string) => path.includes('/packs/');
/** Manifest paths are relative to the app's root, which is this worker's scope. */
const url = (path: string) => new URL(path.replace(/^\//, ''), sw.registration.scope).href;
const shellFiles = [...immutable, ...prerendered, ...assets.filter((f) => !isPack(f.path))].map((f) => url(f.path));

sw.addEventListener('install', (event) => {
	event.waitUntil(
		caches
			.open(SHELL)
			.then((cache) => cache.addAll(shellFiles))
			.then(() => sw.skipWaiting()),
	);
});

sw.addEventListener('activate', (event) => {
	event.waitUntil(
		caches
			.keys()
			.then((keys) => Promise.all(keys.filter((k) => k !== SHELL && k !== PACKS).map((k) => caches.delete(k))))
			.then(() => sw.clients.claim()),
	);
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

async function respond(request: Request): Promise<Response> {
	const url = new URL(request.url);
	const shell = await caches.open(SHELL);
	// Pages: the network when it answers, so a new build is picked up; the cache offline.
	if (request.mode === 'navigate') {
		try {
			return await fetch(request);
		} catch {
			return (await shell.match(request, { ignoreSearch: true })) ?? (await shell.match(new URL('./', sw.registration.scope).href)) ?? Response.error();
		}
	}
	if (isPack(url.pathname)) {
		const packs = await caches.open(PACKS);
		const cached = await packs.match(request);
		if (cached) return cached;
		const response = await fetch(request);
		if (response.ok) await packs.put(request, response.clone());
		return response;
	}
	return (await shell.match(request)) ?? fetch(request);
}

sw.addEventListener('fetch', (event) => {
	const { request } = event;
	if (request.method !== 'GET' || new URL(request.url).origin !== sw.location.origin) return;
	event.respondWith(respond(request).then(isolated));
});
