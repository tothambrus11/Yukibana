<!--
  The page: a top bar (language, project and theme), the dockview layout,
  and a status bar with the language server's state.
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import { createDock } from '../lib/dock';
	import { LANGUAGES, languageOf, type LanguageId } from '../lib/languages';
	import { registerServiceWorker } from '../lib/pwa';
	import { theme } from '../lib/theme.svelte';
	import { Workspace } from '../lib/workspace.svelte';
	import { monaco } from '../lib/monaco';
	import { projectLanguageOf } from '../lib/project';

	const workspace = new Workspace();
	let dockElement: HTMLElement;
	let dock: ReturnType<typeof createDock> | undefined;

	onMount(() => {
		dock = createDock(dockElement, workspace);
		workspace.attach(dock);
		registerServiceWorker((m) => workspace.write('warning', m), () => workspace.flush());
		// The save is debounced; a page being hidden may never come back.
		const hidden = () => document.visibilityState === 'hidden' && workspace.flush();
		const flush = () => workspace.flush();
		const storage = (e: StorageEvent) => {
			const language = e.key && projectLanguageOf(e.key);
			if (language) workspace.savedElsewhere(language);
		};
		addEventListener('pagehide', flush);
		addEventListener('storage', storage);
		document.addEventListener('visibilitychange', hidden);
		return () => {
			removeEventListener('pagehide', flush);
			removeEventListener('storage', storage);
			document.removeEventListener('visibilitychange', hidden);
			dock?.dispose();
		};
	});

	$effect(() => dock?.setProblemCount(workspace.problems.length));

	const errors = $derived(workspace.problems.filter((p) => p.marker.severity === monaco.MarkerSeverity.Error).length);
	const warnings = $derived(workspace.problems.filter((p) => p.marker.severity === monaco.MarkerSeverity.Warning).length);
	const percent = $derived(workspace.progress && workspace.progress.total > 0 ? Math.min(100, (100 * workspace.progress.loaded) / workspace.progress.total) : null);
	const language = $derived(languageOf(workspace.language));
	const mb = (bytes: number) => (bytes / 1048576).toFixed(1);

	function reset() {
		const label = languageOf(workspace.language).label;
		if (confirm(`Replace your ${label} project with the sample? Your changes to it will be lost.`)) void workspace.resetProject();
	}
</script>

<header class="bar">
	<a class="brand" href="./" aria-label="Yukibana Light">
		<img src="logo-64.png" alt="" width="28" height="28" />
		<span class="name">Yukibana</span><span class="product">Light</span>
	</a>

	<label class="select">
		<span class="sr-only">Language</span>
		<select value={workspace.language} onchange={(e) => void workspace.switchTo(e.currentTarget.value as LanguageId)}>
			{#each LANGUAGES as l (l.id)}
				<option value={l.id}>{l.label}</option>
			{/each}
		</select>
		<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6l4 4 4-4" /></svg>
	</label>

	{#if workspace.runner.busy}
		<button class="button run stop" onclick={() => workspace.runner.stop()} title="Stop the program">
			<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="4" y="4" width="8" height="8" rx="1" /></svg>Stop
		</button>
	{:else}
		<button class="button run" onclick={() => workspace.run()} disabled={!language.runs} title={language.runs ? 'Run the project (Ctrl+Enter)' : language.cannotRun}>
			<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 3.5v9l7-4.5z" /></svg>Run
		</button>
	{/if}

	<button class="button" onclick={reset} title="Replace this language's project with the sample">Reset project</button>
	<button class="button" onclick={() => void workspace.restartServer()} title="Restart the language server">Restart server</button>

	<span class="spacer"></span>

	<button class="icon-button" onclick={() => theme.toggle()} aria-label="Switch to {theme.current === 'dark' ? 'light' : 'dark'} theme" title="Toggle theme">
		{#if theme.current === 'dark'}
			<svg viewBox="0 0 24 24"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" /></svg>
		{:else}
			<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>
		{/if}
	</button>
</header>

<main class="dock" bind:this={dockElement}></main>

<footer class="status-bar">
	<span class="state">
		{#if workspace.progress}
			<span class="spinner" aria-hidden="true"></span>
			Downloading {workspace.progress.label}
			{#if percent !== null}
				<span class="meter"><span style:width="{percent}%"></span></span>
				{mb(workspace.progress.loaded)} / {mb(workspace.progress.total)} MB
			{:else}
				{mb(workspace.progress.loaded)} MB
			{/if}
		{:else if workspace.clientState.kind === 'starting'}
			<span class="spinner" aria-hidden="true"></span> Starting the {languageOf(workspace.language).label} language server…
		{:else if workspace.clientState.kind === 'running'}
			<span class="ok" aria-hidden="true"></span> {workspace.clientState.server}
		{:else if workspace.clientState.kind === 'failed'}
			<span class="bad" aria-hidden="true"></span> Language server failed: {workspace.clientState.reason}
		{:else}
			Language server stopped
		{/if}
	</span>
	<span class="counts">
		<span title="Errors"><span class="dot error"></span>{errors}</span>
		<span title="Warnings"><span class="dot warning"></span>{warnings}</span>
	</span>
</footer>

<style>
	.bar {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		min-height: var(--nav-height);
		padding: 0 1.5rem;
		border-bottom: 1px solid var(--gray-5);
		background: var(--header-bg);
		backdrop-filter: blur(0.5rem);
	}
	.brand {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		margin-right: 0.75rem;
		color: var(--white);
		text-decoration: none;
	}
	.brand img {
		width: 1.75rem;
		height: 1.75rem;
	}
	.name {
		font-weight: 700;
		font-size: 1.15rem;
		letter-spacing: -0.01em;
	}
	.product {
		font-weight: 600;
		font-size: 1.05rem;
		color: var(--gray-2);
	}
	.select {
		position: relative;
		display: inline-flex;
		align-items: center;
	}
	.select select {
		appearance: none;
		height: 2rem;
		padding: 0 2rem 0 0.8rem;
		border: 1px solid var(--gray-5);
		border-radius: 0.35rem;
		background: var(--gray-6);
		color: var(--white);
		font: inherit;
		font-size: 0.9rem;
		font-weight: 500;
		cursor: pointer;
	}
	.select svg {
		position: absolute;
		right: 0.6rem;
		width: 0.8rem;
		height: 0.8rem;
		fill: none;
		stroke: var(--gray-2);
		stroke-width: 2;
		pointer-events: none;
	}
	.button {
		height: 2rem;
		padding: 0 0.8rem;
		border: 1px solid var(--gray-5);
		border-radius: 0.35rem;
		background: var(--gray-6);
		color: var(--gray-2);
		font: inherit;
		font-size: 0.85rem;
		cursor: pointer;
	}
	.run {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
		border-color: var(--accent);
		color: var(--white);
		font-weight: 600;
	}
	.run svg {
		width: 0.85rem;
		height: 0.85rem;
		fill: var(--accent-high);
	}
	.run.stop svg {
		fill: var(--red-high);
	}
	.run:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
	.button:hover,
	.button:focus-visible,
	.select select:hover {
		border-color: var(--gray-4);
		color: var(--white);
	}
	.spacer {
		flex: 1;
	}
	.icon-button {
		display: inline-grid;
		place-items: center;
		width: 2rem;
		height: 2rem;
		border: 0;
		border-radius: 0.35rem;
		background: none;
		color: var(--gray-2);
		cursor: pointer;
	}
	.icon-button:hover {
		color: var(--accent-high);
	}
	.icon-button svg {
		width: 1.1rem;
		height: 1.1rem;
		fill: none;
		stroke: currentColor;
		stroke-width: 2;
		stroke-linecap: round;
	}
	.dock {
		flex: 1;
		min-height: 0;
	}
	.status-bar {
		display: flex;
		justify-content: space-between;
		gap: 1rem;
		padding: 0.35rem 1rem;
		border-top: 1px solid var(--gray-5);
		color: var(--gray-3);
		font-size: 0.8rem;
	}
	.state {
		display: flex;
		align-items: center;
		gap: 0.45rem;
		min-width: 0;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.meter {
		display: inline-block;
		width: 8rem;
		height: 0.35rem;
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
	.spinner {
		width: 0.75rem;
		height: 0.75rem;
		border: 1.5px solid var(--gray-4);
		border-top-color: var(--accent-high);
		border-radius: 50%;
		animation: spin 0.8s linear infinite;
	}
	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}
	.ok,
	.bad,
	.dot {
		display: inline-block;
		width: 0.5rem;
		height: 0.5rem;
		border-radius: 50%;
	}
	.ok {
		background: var(--accent-high);
	}
	.bad,
	.dot.error {
		background: var(--red-high);
	}
	.dot.warning {
		background: var(--orange-high);
	}
	.counts {
		display: flex;
		gap: 0.9rem;
	}
	.counts > span {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
	}
	.sr-only {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip: rect(0 0 0 0);
	}
	@media (width < 40em) {
		.bar {
			padding: 0 0.75rem;
			gap: 0.4rem;
		}
		.product,
		.button:not(.run) {
			display: none;
		}
	}
</style>
