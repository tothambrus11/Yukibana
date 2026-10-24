/**
 * What is available offline, and downloading the rest ahead of time: every
 * pack's files and the app's lazy files, into the caches the service worker
 * serves from (offline-cache.ts), so that a later visit without a network
 * finds them. The list of files and their sizes is the build's
 * `offline.json`.
 *
 * The page fetches and stores the files itself, rather than leaving it to
 * the service worker, so that it can show progress byte by byte and does
 * not depend on the worker being in control yet (the first visit's page is
 * not, until its one reload).
 */
import { version } from '$app/env';
import { appCacheName, DIRECT_HEADER, isOfflineManifest, isPackPath, MANIFEST_PATH, PACKS_CACHE, storable, type OfflineFile, type OfflineManifest } from './offline-cache';

/** Several files at a time: a pack is a few large files and some small ones. */
const PARALLEL = 4;

export interface DownloadProgress {
	/** What is being downloaded, for people: "everything", or a language's name. */
	label: string;
	/** Bytes stored so far and in all, uncompressed (what `OfflineFile.size` counts). */
	loaded: number;
	total: number;
}

/** Bytes to download and to store, for a set of files. */
export interface Sizes {
	transfer: number;
	size: number;
	files: number;
}

const sum = (files: readonly OfflineFile[]): Sizes => ({ transfer: files.reduce((n, f) => n + f.transfer, 0), size: files.reduce((n, f) => n + f.size, 0), files: files.length });
/** A path relative to the app's root as a URL; `''` is the root itself, without the page's query. */
const url = (path: string) => new URL(path, new URL('./', document.baseURI)).href;

export class Offline {
	/** The build's file list; null until loaded, or when the build has none (dev server). */
	manifest = $state<OfflineManifest | null>(null);
	/** Paths (relative to the root) found in the caches at the last check. */
	cached = $state<ReadonlySet<string>>(new Set());
	progress = $state<DownloadProgress | null>(null);
	/** Why the last download stopped short, if it did. */
	error = $state<string | null>(null);
	private abort: AbortController | null = null;

	/** Reads offline.json and checks which of its files are cached. Never throws. */
	async refresh(): Promise<void> {
		try {
			const response = await fetch(url(MANIFEST_PATH));
			const m: unknown = response.ok ? await response.json() : null;
			this.manifest = isOfflineManifest(m) ? m : null;
		} catch {
			this.manifest = null;
		}
		if (!this.manifest || !('caches' in globalThis)) return;
		const [app, packs] = await Promise.all([caches.open(appCacheName(version)), caches.open(PACKS_CACHE)]);
		const cached = new Set<string>();
		const all = [...this.manifest.shell, ...this.manifest.lazy, ...Object.values(this.manifest.packs).flat()];
		await Promise.all(all.map(async (f) => ((await (isPackPath(f.path) ? packs : app).match(url(f.path))) ? cached.add(f.path) : undefined)));
		this.cached = cached;
	}

	/** The pack directories the build has. */
	get packs(): string[] {
		return Object.keys(this.manifest?.packs ?? {});
	}

	/** Every file of a pack (empty when the build does not have it). */
	packFiles(pack: string): readonly OfflineFile[] {
		return this.manifest?.packs[pack] ?? [];
	}

	/** The files a language needs offline: its pack's, and the app's lazy files (small, shared by all). */
	filesFor(packs: readonly string[]): OfflineFile[] {
		return [...(this.manifest?.lazy ?? []), ...packs.flatMap((p) => this.packFiles(p))];
	}

	/** Everything the build can serve. */
	get everything(): OfflineFile[] {
		return [...(this.manifest?.shell ?? []), ...this.filesFor(this.packs)];
	}

	/** Whether every file of a pack is cached; false for a pack the build lacks. */
	isPackCached(pack: string): boolean {
		const files = this.packFiles(pack);
		return files.length > 0 && files.every((f) => this.cached.has(f.path));
	}

	/** Sizes of all of `files`, and of those still missing. */
	sizes(files: readonly OfflineFile[]): { all: Sizes; missing: Sizes } {
		return { all: sum(files), missing: sum(files.filter((f) => !this.cached.has(f.path))) };
	}

	/**
	 * Downloads and caches whichever of `files` are not cached yet, showing
	 * progress. Asks the browser to keep the caches (persistent storage), so
	 * they are not evicted under storage pressure. Resolves when done,
	 * cancelled or failed; `error` says which files failed.
	 */
	async download(label: string, files: readonly OfflineFile[]): Promise<void> {
		if (this.progress) return;
		const missing = files.filter((f) => !this.cached.has(f.path));
		const abort = (this.abort = new AbortController());
		this.progress = { label, loaded: 0, total: sum(missing).size };
		const progress = this.progress;
		this.error = null;
		try {
			await navigator.storage?.persist?.().catch(() => false);
			const estimate = await navigator.storage?.estimate?.().catch(() => undefined);
			if (estimate?.quota !== undefined && estimate.usage !== undefined && estimate.quota - estimate.usage < progress.total) {
				throw new Error(`the browser allows this site ${mb(estimate.quota - estimate.usage)} MB more storage, and ${mb(progress.total)} MB are needed`);
			}
			const [app, packs] = await Promise.all([caches.open(appCacheName(version)), caches.open(PACKS_CACHE)]);
			const queue = [...missing];
			const failed: string[] = [];
			const worker = async () => {
				for (let file = queue.shift(); file && !abort.signal.aborted; file = queue.shift()) {
					try {
						await this.fetchInto(isPackPath(file.path) ? packs : app, file, abort.signal, (n) => (progress.loaded += n));
						this.cached = new Set([...this.cached, file.path]);
					} catch (e) {
						if (!abort.signal.aborted) failed.push(`${file.path || 'index.html'} (${e instanceof Error ? e.message : String(e)})`);
					}
				}
			};
			await Promise.all(Array.from({ length: PARALLEL }, worker));
			if (failed.length) this.error = `${failed.length} file(s) could not be downloaded: ${failed.slice(0, 3).join(', ')}${failed.length > 3 ? ', …' : ''}`;
		} catch (e) {
			this.error = `The download stopped: ${e instanceof Error ? e.message : String(e)}`;
		} finally {
			this.progress = null;
			this.abort = null;
		}
	}

	/** Stops a download; what is already stored stays. */
	cancel(): void {
		this.abort?.abort();
	}

	/** Fetches one file and stores it, reporting each chunk's size as it arrives. */
	private async fetchInto(cache: Cache, file: OfflineFile, signal: AbortSignal, received: (bytes: number) => void): Promise<void> {
		const response = await fetch(url(file.path), { headers: { [DIRECT_HEADER]: '1' }, cache: 'no-store', signal });
		if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
		const [counted, stored] = response.body.tee();
		const reader = counted.getReader();
		const count = (async () => {
			for (let r = await reader.read(); !r.done; r = await reader.read()) received(r.value.byteLength);
		})();
		await Promise.all([count, cache.put(url(file.path), storable(new Response(stored, response), isPackPath(file.path) ? file : undefined))]);
	}
}

/** Megabytes with one decimal. */
export const mb = (bytes: number): string => (bytes / 1048576).toFixed(1);

export const offline = new Offline();
