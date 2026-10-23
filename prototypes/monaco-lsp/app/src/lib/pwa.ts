/**
 * Registers the service worker (see `src/service-worker/index.ts`), offers
 * a new build when one has installed, and, on a host that does not send
 * COOP/COEP headers itself, reloads the page once when the worker first
 * takes control, because only then is the page served with them and
 * cross-origin isolated.
 */

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
		.then((registration) => watchUpdates(registration, events, () => (updating = true)))
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

/** Runs a session storage access; `null` also when storage is unavailable (blocked, private mode). */
function session<T>(access: () => T): T | null {
	try {
		return access();
	} catch {
		return null;
	}
}
