import adapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

// Language servers that block on stdin need SharedArrayBuffer, which needs a
// cross-origin isolated page. The dev and preview servers send the headers;
// a static host that cannot is covered by the service worker.
const isolation = {
	'Cross-Origin-Opener-Policy': 'same-origin',
	'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
	plugins: [
		sveltekit({
			// Every page is prerendered and the app runs entirely in the browser,
			// so the output is a folder of static files any web server can serve.
			adapter: adapter({ pages: 'build', assets: 'build', precompress: false }),
			// Registered by hand (src/lib/pwa.ts), so the page can reload once
			// to become cross-origin isolated.
			serviceWorker: { register: false },
		}),
	],
	server: { headers: isolation },
	preview: { headers: isolation },
	worker: { format: 'es' },
});
