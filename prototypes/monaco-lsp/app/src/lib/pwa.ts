/**
 * Registers the service worker (see `src/service-worker.ts`) and, on a host
 * that does not send COOP/COEP headers itself, reloads the page once when
 * the worker first takes control, because only then is the page served with
 * them and cross-origin isolated.
 */

const RELOADED = 'yukibana.code.isolation-reload';

/** Starts registration; never throws, since the app also works without it, just not offline. */
export function registerServiceWorker(report: (message: string) => void): void {
	if (!('serviceWorker' in navigator)) {
		report('This browser has no service workers: the app will not work offline.');
		return;
	}
	const hadController = navigator.serviceWorker.controller !== null;
	navigator.serviceWorker
		.register(new URL('service-worker.js', document.baseURI), { type: import.meta.env.DEV ? 'module' : 'classic', scope: './' })
		.catch((e: unknown) => report(`The service worker did not register: ${e instanceof Error ? e.message : String(e)}`));

	if (crossOriginIsolated) {
		sessionStorage.removeItem(RELOADED);
		return;
	}
	if (hadController) {
		// Controlled and still not isolated: the browser refuses isolation here
		// (an embedding page, or an old browser). Reloading again would loop.
		report('The page is not cross-origin isolated, so language servers that need SharedArrayBuffer cannot start.');
		return;
	}
	navigator.serviceWorker.addEventListener('controllerchange', () => {
		if (sessionStorage.getItem(RELOADED)) return;
		sessionStorage.setItem(RELOADED, '1');
		location.reload();
	});
}
