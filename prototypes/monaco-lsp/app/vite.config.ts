import adapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig, type Plugin } from 'vite';

// Language servers that block on stdin need SharedArrayBuffer, which needs a
// cross-origin isolated page. The dev and preview servers send the headers;
// a static host that cannot is covered by the service worker.
const isolation = {
	'Cross-Origin-Opener-Policy': 'same-origin',
	'Cross-Origin-Embedder-Policy': 'require-corp',
};

/**
 * Monaco's JSON service creates its worker with `internal/common/workers.js`,
 * which imports every editor contribution as a side effect; it is replaced by
 * src/lib/monaco-workers.ts, the same function without them.
 */
const monacoWorkers: Plugin = {
	name: 'yukibana:monaco-workers',
	enforce: 'pre',
	resolveId(source, importer) {
		if (importer?.includes('/monaco-editor/') && source.endsWith('/internal/common/workers.js')) {
			return decodeURIComponent(new URL('./src/lib/monaco-workers.ts', import.meta.url).pathname);
		}
		return null;
	},
};

export default defineConfig({
	plugins: [
		monacoWorkers,
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
