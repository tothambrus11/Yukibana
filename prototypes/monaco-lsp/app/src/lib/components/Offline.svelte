<!--
  The Offline dialog: which languages work without a network, a button per
  language to make it so, and Download everything, with the sizes before
  starting and the progress while it runs (offline.svelte.ts does the work).
-->
<script lang="ts">
	import { LANGUAGES, packOf } from '../languages';
	import { mb, offline } from '../offline.svelte';

	let dialog: HTMLDialogElement;

	/** Opens the dialog and rechecks the caches. */
	export function show(): void {
		dialog.showModal();
		void offline.refresh();
	}

	const shell = $derived(offline.manifest ? offline.sizes(offline.manifest.shell) : null);
	const everything = $derived(offline.sizes(offline.everything));
	const percent = $derived(offline.progress && offline.progress.total > 0 ? Math.min(100, (100 * offline.progress.loaded) / offline.progress.total) : 0);

	async function makeAvailable(label: string, pack: string) {
		await offline.download(label, offline.filesFor([pack]));
	}
</script>

<dialog class="offline" bind:this={dialog} aria-labelledby="offline-title" onclick={(e) => e.target === dialog && dialog.close()}>
	<header>
		<h2 id="offline-title">Offline</h2>
		<button class="close" onclick={() => dialog.close()} aria-label="Close">×</button>
	</header>

	{#if !offline.manifest}
		<p>This build has no list of its files (offline.json), so nothing can be downloaded ahead of time. Languages used once still work offline.</p>
	{:else}
		<p>
			{#if shell && shell.missing.files === 0}
				The app is cached: it starts without a network.
			{:else}
				The app is not fully cached yet; it will be once its service worker has installed.
			{/if}
			A language works offline once its files are cached: when it is first used, or from here.
		</p>

		<table>
			<thead>
				<tr><th>Language</th><th class="size">Download</th><th></th></tr>
			</thead>
			<tbody>
				{#each LANGUAGES as l (l.id)}
					{@const pack = packOf(l)}
					{@const files = offline.packFiles(pack)}
					{@const sizes = offline.sizes(offline.filesFor([pack]))}
					<tr data-language={l.id}>
						<td>{l.label}</td>
						<td class="size">{files.length ? `${mb(sizes.all.transfer)} MB` : ''}</td>
						<td class="action">
							{#if !files.length}
								<span class="muted">not installed</span>
							{:else if offline.isPackCached(pack) && sizes.missing.files === 0}
								<span class="ok">available offline</span>
							{:else}
								<button class="button" disabled={offline.progress !== null} onclick={() => void makeAvailable(l.label, pack)}>Make available offline ({mb(sizes.missing.transfer)} MB)</button>
							{/if}
						</td>
					</tr>
				{/each}
			</tbody>
		</table>

		<footer>
			{#if offline.progress}
				<div class="progress" role="status">
					<span>Downloading {offline.progress.label}: {mb(offline.progress.loaded)} / {mb(offline.progress.total)} MB</span>
					<span class="meter"><span style:width="{percent}%"></span></span>
					<button class="button" onclick={() => offline.cancel()}>Cancel</button>
				</div>
			{:else if everything.missing.files === 0}
				<span class="ok">Everything is available offline ({mb(everything.all.size)} MB stored).</span>
			{:else}
				<button class="button primary download-all" onclick={() => void offline.download('everything', offline.everything)}>Download everything</button>
				<span class="muted">{mb(everything.missing.transfer)} MB to download, {mb(everything.missing.size)} MB stored, every language and the editor's parts</span>
			{/if}
			{#if offline.error}
				<p class="error">{offline.error}</p>
			{/if}
		</footer>
	{/if}
</dialog>

<style>
	.offline {
		width: min(40rem, calc(100vw - 2rem));
		padding: 0;
		border: 1px solid var(--gray-5);
		border-radius: 0.5rem;
		background: var(--gray-7);
		color: var(--white);
		font-size: 0.9rem;
	}
	.offline::backdrop {
		background: rgb(0 0 0 / 0.45);
	}
	header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 0.75rem 1rem 0;
	}
	h2 {
		margin: 0;
		font-size: 1.05rem;
	}
	.close {
		border: 0;
		background: none;
		color: var(--gray-2);
		font-size: 1.4rem;
		cursor: pointer;
	}
	p {
		margin: 0.5rem 1rem;
		color: var(--gray-2);
		line-height: 1.4;
	}
	table {
		width: calc(100% - 2rem);
		margin: 0.5rem 1rem;
		border-collapse: collapse;
	}
	th {
		color: var(--gray-3);
		font-weight: 500;
		text-align: left;
	}
	th,
	td {
		padding: 0.3rem 0.4rem;
		border-bottom: 1px solid var(--gray-6);
	}
	.size {
		text-align: right;
		white-space: nowrap;
	}
	.action {
		text-align: right;
	}
	footer {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem 0.75rem;
		padding: 0.5rem 1rem 1rem;
	}
	.progress {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem 0.75rem;
		width: 100%;
	}
	.meter {
		flex: 1;
		min-width: 6rem;
		height: 0.4rem;
		border-radius: 1rem;
		background: var(--gray-5);
		overflow: hidden;
	}
	.meter span {
		display: block;
		height: 100%;
		background: var(--accent-high);
		transition: width 0.2s;
	}
	.button {
		height: 1.9rem;
		padding: 0 0.7rem;
		border: 1px solid var(--gray-5);
		border-radius: 0.35rem;
		background: var(--gray-6);
		color: var(--gray-2);
		font: inherit;
		font-size: 0.8rem;
		cursor: pointer;
	}
	.button:hover:not(:disabled) {
		border-color: var(--gray-4);
		color: var(--white);
	}
	.button:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
	.primary {
		border-color: var(--accent);
		color: var(--white);
		font-weight: 600;
	}
	.ok {
		color: var(--accent-high);
	}
	.muted {
		color: var(--gray-3);
	}
	.error {
		width: 100%;
		margin: 0;
		color: var(--red-high);
	}
</style>
