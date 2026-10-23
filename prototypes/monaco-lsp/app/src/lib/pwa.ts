/**
 * Registers the service worker (see `src/service-worker.ts`) and, on a host
 * that does not send COOP/COEP headers itself, reloads the page once when
 * the worker first takes control, because only then is the page served with
 * them and cross-origin isolated.
 */

const RELOADED = 'yukibana.code.isolation-reload';

/**
 * Starts registration; never throws, since the app also works without it,
 * just not offline. `beforeReload` runs before the one-time reload, to save.
 */
export function registerServiceWorker(report: (message: string) => void, beforeReload: () => void): void {
	if (!('serviceWorker' in navigator)) {
		report('This browser has no service workers: the app will not work offline.');
		return;
	}
	const hadController = navigator.serviceWorker.controller !== null;
	navigator.serviceWorker
		.register(new URL('service-worker.js', document.baseURI), { type: import.meta.env.DEV ? 'module' : 'classic', scope: './' })
		.catch((e: unknown) => report(`The service worker did not register: ${e instanceof Error ? e.message : String(e)}`));

	if (crossOriginIsolated) {
		session(() => sessionStorage.removeItem(RELOADED));
		return;
	}
	if (hadController) {
		// Controlled and still not isolated: the browser refuses isolation here
		// (an embedding page, or an old browser). Reloading again would loop.
		report('The page is not cross-origin isolated, so language servers that need SharedArrayBuffer cannot start.');
		return;
	}
	navigator.serviceWorker.addEventListener('controllerchange', () => {
		// Without session storage there is no way to tell a second reload from
		// the first, so do not reload at all rather than risk a loop.
		if (session(() => sessionStorage.getItem(RELOADED)) !== null) return;
		if (session(() => sessionStorage.setItem(RELOADED, '1')) === null) return;
		beforeReload();
		location.reload();
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
