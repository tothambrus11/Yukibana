/**
 * Registers the service worker (see `src/service-worker/index.ts`), offers
 * a new build when one has installed, and, on a host that does not send
 * COOP/COEP headers itself, reloads the page once when the worker first
 * takes control, because only then is the page served with them and
 * cross-origin isolated.
 */

import { version } from '$app/env';

const RELOADED = 'yukibana.code.isolation-reload';
/** How often an open tab asks whether a new build is out, besides when it becomes visible. */
const UPDATE_CHECK_MS = 60 * 60 * 1000;

export interface ServiceWorkerEvents {
	/** Something the user should know: the app will not work offline, or not isolated. */
	report(message: string): void;
	/** Runs before any reload this module does, to save. */
	beforeReload(): void;
	/**
	 * A new build is installed and waiting. `apply` activates it and reloads
	 * the page; until it is called, this tab keeps running the build it has.
	 */
	updateReady(apply: () => void): void;
}

/** Starts registration; never throws, since the app also works without it, just not offline. */
export function registerServiceWorker(events: ServiceWorkerEvents): void {
	if (!('serviceWorker' in navigator)) {
		events.report('This browser has no service workers: the app will not work offline.');
		return;
	}
	const hadController = navigator.serviceWorker.controller !== null;
	let updating = false;
	navigator.serviceWorker
		.register(new URL('service-worker.js', document.baseURI), { type: import.meta.env.DEV ? 'module' : 'classic', scope: './' })
		.then((registration) => {
			watchUpdates(registration, events, () => (updating = true));
			if (hadController) void switchIfStale(registration, () => (updating = true));
		})
		.catch((e: unknown) => events.report(`The service worker did not register: ${e instanceof Error ? e.message : String(e)}`));

	// A new build took over because this tab asked it to: show it.
	navigator.serviceWorker.addEventListener('controllerchange', () => {
		if (!updating) return;
		events.beforeReload();
		location.reload();
	});

	if (crossOriginIsolated) {
		session(() => sessionStorage.removeItem(RELOADED));
		return;
	}
	if (hadController) {
		// Controlled and still not isolated: the browser refuses isolation here
		// (an embedding page, or an old browser). Reloading again would loop.
		events.report('The page is not cross-origin isolated, so language servers that need SharedArrayBuffer cannot start.');
		return;
	}
	navigator.serviceWorker.addEventListener('controllerchange', () => {
		if (updating) return;
		// Without session storage there is no way to tell a second reload from
		// the first, so do not reload at all rather than risk a loop.
		if (session(() => sessionStorage.getItem(RELOADED)) !== null) return;
		if (session(() => sessionStorage.setItem(RELOADED, '1')) === null) return;
		events.beforeReload();
		location.reload();
	});
}

/**
 * Calls `updateReady` whenever a new build's worker is waiting behind the
 * one controlling this page (not for the first install, which has nothing
 * to replace), and looks for new builds now and then.
 */
function watchUpdates(registration: ServiceWorkerRegistration, events: ServiceWorkerEvents, applying: () => void): void {
	const offer = () => {
		const waiting = registration.waiting;
		if (!waiting || !navigator.serviceWorker.controller) return;
		events.updateReady(() => {
			applying();
			waiting.postMessage('skip-waiting');
		});
	};
	offer();
	registration.addEventListener('updatefound', () => {
		const installing = registration.installing;
		installing?.addEventListener('statechange', () => {
			if (installing.state === 'installed') offer();
		});
	});
	const check = () => void registration.update().catch(() => undefined); // offline: try later
	setInterval(check, UPDATE_CHECK_MS);
	document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && check());
}

/** How long a controlling worker may take to say which build it is; one from before it could say never answers. */
const VERSION_WAIT_MS = 1500;

/**
 * Activates the new build at once when the worker controlling this page is
 * another build than the page: a worker from before pages came from the
 * worker's own cache serves the network's new page, then that page's
 * packs from the old build's cache (C++ Test then missed the doctest
 * headers). The waiting worker is the page's build; the reload that
 * follows (controllerchange) brings page and packs together. The page has
 * only just loaded, so nothing is lost.
 */
async function switchIfStale(registration: ServiceWorkerRegistration, applying: () => void): Promise<void> {
	const controller = navigator.serviceWorker.controller;
	if (!controller) return;
	const theirs = await new Promise<string | null>((resolve) => {
		const channel = new MessageChannel();
		const timer = setTimeout(() => resolve(null), VERSION_WAIT_MS);
		channel.port1.onmessage = (e: MessageEvent<unknown>) => {
			clearTimeout(timer);
			resolve(typeof e.data === 'string' ? e.data : null);
		};
		controller.postMessage('version', [channel.port2]);
	});
	if (theirs === version) return;
	const worker = registration.waiting ?? (await installed(registration));
	if (!worker) return; // No newer build installed (offline, or none deployed): keep running.
	applying();
	worker.postMessage('skip-waiting');
}

/** How long to wait for the page's build to install behind a stale worker. */
const INSTALL_WAIT_MS = 60_000;

/**
 * The page's build's worker once it has installed: the waiting one, the
 * one installing, or the one the registration's update check is about to
 * find (right after `register` resolves, it has often not started yet).
 * Null if none installs in time or it fails.
 */
function installed(registration: ServiceWorkerRegistration): Promise<ServiceWorker | null> {
	if (registration.waiting) return Promise.resolve(registration.waiting);
	return new Promise((resolve) => {
		const timer = setTimeout(() => resolve(null), INSTALL_WAIT_MS);
		const follow = (worker: ServiceWorker) => {
			const settle = () => {
				if (worker.state === 'installed') resolve(worker);
				else if (worker.state === 'redundant') resolve(null);
				else return;
				clearTimeout(timer);
			};
			worker.addEventListener('statechange', settle);
			settle();
		};
		if (registration.installing) follow(registration.installing);
		else {
			registration.addEventListener('updatefound', () => registration.installing && follow(registration.installing), { once: true });
			void registration.update().catch(() => undefined);
		}
	});
}

/** Runs a session storage access; `null` also when storage is unavailable (blocked, private mode). */
function session<T>(access: () => T): T | null {
	try {
		return access();
	} catch {
		return null;
	}
}
