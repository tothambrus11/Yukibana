<!--
  The folder browser: the project's files and folders as a tree, with
  creating, renaming and deleting in place. Folders are expanded unless the
  user collapsed them.
-->
<script lang="ts">
	import { monaco } from '../monaco';
	import { baseName, parentOf } from '../project';
	import type { Workspace } from '../workspace.svelte';

	let { workspace }: { workspace: Workspace } = $props();

	interface Node {
		path: string;
		name: string;
		depth: number;
		folder: boolean;
	}

	/** What is being typed in place: a new entry under `parent`, or a new name for `path`. */
	type Editing = { kind: 'file' | 'folder'; parent: string } | { kind: 'rename'; path: string } | null;

	let collapsed = $state(new Set<string>());
	let editing = $state<Editing>(null);
	let draft = $state('');
	let error = $state<string | null>(null);
	let selectedFolder = $state('');

	const folders = $derived(workspace.allFolders());

	/** Folders first, then files, each alphabetically, skipping collapsed subtrees. */
	const nodes = $derived.by(() => {
		const out: Node[] = [];
		const walk = (parent: string, depth: number) => {
			const childFolders = folders.filter((f) => parentOf(f) === parent);
			const childFiles = workspace.files.filter((f) => parentOf(f) === parent);
			for (const f of childFolders) {
				out.push({ path: f, name: baseName(f), depth, folder: true });
				if (!collapsed.has(f)) walk(f, depth + 1);
			}
			for (const f of childFiles) out.push({ path: f, name: baseName(f), depth, folder: false });
		};
		walk('', 0);
		return out;
	});

	/** Highest severity per file, for the dot next to its name. */
	const severity = $derived.by(() => {
		const map = new Map<string, number>();
		for (const p of workspace.problems) map.set(p.path, Math.max(map.get(p.path) ?? 0, p.marker.severity));
		return map;
	});

	function folderSeverity(folder: string): number {
		let max = 0;
		for (const [path, s] of severity) if (path.startsWith(folder + '/')) max = Math.max(max, s);
		return max;
	}

	function toggle(folder: string) {
		const next = new Set(collapsed);
		if (!next.delete(folder)) next.add(folder);
		collapsed = next;
		selectedFolder = folder;
	}

	function startCreate(kind: 'file' | 'folder') {
		const parent = selectedFolder;
		if (parent) collapsed = new Set([...collapsed].filter((f) => f !== parent));
		editing = { kind, parent };
		draft = '';
		error = null;
	}

	function startRename(path: string) {
		editing = { kind: 'rename', path };
		draft = baseName(path);
		error = null;
	}

	function target(): string {
		if (!editing) return '';
		const parent = editing.kind === 'rename' ? parentOf(editing.path) : editing.parent;
		return parent ? `${parent}/${draft.trim()}` : draft.trim();
	}

	function validate() {
		if (!editing) return;
		const path = target();
		const unchanged = editing.kind === 'rename' && path === editing.path;
		error = unchanged ? null : workspace.nameProblem(path);
	}

	function commit() {
		const current = editing;
		if (!current) return;
		const path = target();
		try {
			if (current.kind === 'rename') workspace.rename(current.path, path);
			else if (current.kind === 'file') workspace.createFile(path);
			else workspace.createFolder(path);
			editing = null;
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		}
	}

	function cancel() {
		editing = null;
		error = null;
	}

	function remove(node: Node) {
		const what = node.folder ? `the folder "${node.path}" and everything in it` : `"${node.path}"`;
		if (confirm(`Delete ${what}?`)) workspace.delete(node.path);
	}

	function keydown(e: KeyboardEvent) {
		if (e.key === 'Enter') commit();
		else if (e.key === 'Escape') cancel();
	}

	function focusInput(el: HTMLInputElement) {
		el.focus();
		const dot = el.value.lastIndexOf('.');
		el.setSelectionRange(0, dot > 0 ? dot : el.value.length);
	}

	const sev = (s: number) => (s >= monaco.MarkerSeverity.Error ? 'error' : s >= monaco.MarkerSeverity.Warning ? 'warning' : '');
</script>

{#snippet input(depth: number, folder: boolean)}
	<div class="row editing" style:--depth={depth}>
		<span class="icon">{folder ? '▸' : ''}</span>
		<input
			use:focusInput
			bind:value={draft}
			oninput={validate}
			onkeydown={keydown}
			onblur={() => (error ? cancel() : draft.trim() ? commit() : cancel())}
			aria-invalid={error ? 'true' : undefined}
			aria-label={folder ? 'Folder name' : 'File name'}
			spellcheck="false"
		/>
	</div>
	{#if error}<div class="error-hint" style:--depth={depth}>{error}</div>{/if}
{/snippet}

<div class="explorer">
	<div class="toolbar">
		<span class="spacer"></span>
		<button title="New file" aria-label="New file" onclick={() => startCreate('file')}>
			<svg viewBox="0 0 16 16"><path d="M9 1.5H4a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V5.5zM9 1.5v4h4M8 8v4M6 10h4" /></svg>
		</button>
		<button title="New folder" aria-label="New folder" onclick={() => startCreate('folder')}>
			<svg viewBox="0 0 16 16"><path d="M1.5 3.5a1 1 0 0 1 1-1h3.5l1.5 1.5h6a1 1 0 0 1 1 1v7.5a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1zM8 7v4M6 9h4" /></svg>
		</button>
		<button title="Download the project for an IDE" aria-label="Download the project" onclick={() => void workspace.download()}>
			<svg viewBox="0 0 16 16"><path d="M8 2v8M4.5 6.5L8 10l3.5-3.5M2.5 11v2a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-2" /></svg>
		</button>
		<button title="Collapse folders" aria-label="Collapse folders" onclick={() => (collapsed = new Set(folders))}>
			<svg viewBox="0 0 16 16"><path d="M4 6l4 4 4-4" transform="rotate(180 8 8)" /></svg>
		</button>
	</div>

	<div class="tree" role="tree">
		{#if editing && editing.kind !== 'rename' && editing.parent === ''}
			{@render input(0, editing.kind === 'folder')}
		{/if}
		{#each nodes as node (node.path)}
			{#if editing?.kind === 'rename' && editing.path === node.path}
				{@render input(node.depth, node.folder)}
			{:else}
				{@const s = sev(node.folder ? folderSeverity(node.path) : (severity.get(node.path) ?? 0))}
				<div
					class="row"
					class:active={!node.folder && workspace.active === node.path}
					class:selected={node.folder && selectedFolder === node.path}
					style:--depth={node.depth}
					role="treeitem"
					aria-selected={!node.folder && workspace.active === node.path}
					aria-expanded={node.folder ? !collapsed.has(node.path) : undefined}
					tabindex="0"
					onclick={() => (node.folder ? toggle(node.path) : ((selectedFolder = parentOf(node.path)), workspace.show(node.path)))}
					onkeydown={(e) => {
						if (e.key === 'Enter') node.folder ? toggle(node.path) : workspace.show(node.path);
						else if (e.key === 'F2') startRename(node.path);
						else if (e.key === 'Delete') remove(node);
					}}
				>
					<span class="icon" class:open={node.folder && !collapsed.has(node.path)}>
						{#if node.folder}
							<svg viewBox="0 0 16 16"><path d="M6 4l4 4-4 4" /></svg>
						{:else}
							<span class="ext ext-{node.name.split('.').pop()}"></span>
						{/if}
					</span>
					<span class="name {s}">{node.name}</span>
					{#if s}<span class="dot {s}"></span>{/if}
					<span class="actions">
						<button title="Rename" aria-label="Rename {node.name}" onclick={(e) => (e.stopPropagation(), startRename(node.path))}>
							<svg viewBox="0 0 16 16"><path d="M11 2.5l2.5 2.5-7.5 7.5H3.5V10z" /></svg>
						</button>
						<button title="Delete" aria-label="Delete {node.name}" onclick={(e) => (e.stopPropagation(), remove(node))}>
							<svg viewBox="0 0 16 16"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.5 9h6l.5-9" /></svg>
						</button>
					</span>
				</div>
				{#if node.folder && editing && editing.kind !== 'rename' && editing.parent === node.path}
					{@render input(node.depth + 1, editing.kind === 'folder')}
				{/if}
			{/if}
		{/each}
	</div>
	<!-- Clicking empty space selects the root, so "new file" goes there. -->
	<div class="rest" role="presentation" onclick={() => (selectedFolder = '')}></div>
</div>

<style>
	.explorer {
		height: 100%;
		display: flex;
		flex-direction: column;
		font-size: 0.8125rem;
		user-select: none;
	}
	.toolbar {
		display: flex;
		align-items: center;
		gap: 0.15rem;
		padding: 0.4rem 0.5rem 0.3rem 0.85rem;
		color: var(--gray-3);
	}
	.spacer {
		flex: 1;
	}
	button {
		display: inline-grid;
		place-items: center;
		width: 1.5rem;
		height: 1.5rem;
		padding: 0;
		border: 0;
		border-radius: 0.3rem;
		background: none;
		color: inherit;
		cursor: pointer;
	}
	button:hover,
	button:focus-visible {
		background: var(--gray-5);
		color: var(--white);
	}
	svg {
		width: 0.95rem;
		height: 0.95rem;
		fill: none;
		stroke: currentColor;
		stroke-width: 1.3;
		stroke-linecap: round;
		stroke-linejoin: round;
	}
	.tree {
		overflow: auto;
		padding-bottom: 0.25rem;
	}
	.rest {
		flex: 1;
	}
	.row {
		display: flex;
		align-items: center;
		gap: 0.3rem;
		height: 1.65rem;
		padding-left: calc(0.6rem + var(--depth) * 0.9rem);
		padding-right: 0.35rem;
		color: var(--gray-2);
		cursor: pointer;
		outline: none;
	}
	.row:hover {
		background: var(--gray-6);
		color: var(--white);
	}
	.row:focus-visible {
		box-shadow: inset 0 0 0 1px var(--accent);
	}
	.row.active {
		background: var(--accent-low);
		color: var(--white);
		box-shadow: inset 2px 0 0 var(--accent-high);
	}
	.row.selected {
		color: var(--white);
	}
	.icon {
		display: inline-grid;
		place-items: center;
		width: 1rem;
		flex: none;
		color: var(--gray-3);
	}
	.icon svg {
		width: 0.75rem;
		height: 0.75rem;
		transition: transform 0.12s ease;
	}
	.icon.open svg {
		transform: rotate(90deg);
	}
	.ext {
		width: 0.45rem;
		height: 0.45rem;
		border-radius: 50%;
		background: var(--gray-4);
	}
	.ext-py { background: #4b8bbe; }
	.ext-js, .ext-mjs { background: #e8c547; }
	.ext-ts { background: #3178c6; }
	.ext-c, .ext-h { background: #8b9dc3; }
	.ext-cpp, .ext-hpp, .ext-cc { background: #f34b7d; }
	.ext-swift { background: #f05138; }
	.ext-scala, .ext-sc { background: #dc322f; }
	.ext-json { background: #9ba3a3; }
	.name {
		flex: 1;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.name.error {
		color: var(--red-high);
	}
	.name.warning {
		color: var(--orange-high);
	}
	.dot {
		width: 0.4rem;
		height: 0.4rem;
		border-radius: 50%;
		flex: none;
	}
	.dot.error {
		background: var(--red-high);
	}
	.dot.warning {
		background: var(--orange-high);
	}
	.actions {
		display: none;
		gap: 0.05rem;
	}
	.actions button {
		width: 1.3rem;
		height: 1.3rem;
	}
	.row:hover .actions,
	.row:focus-within .actions {
		display: flex;
	}
	.row:hover .dot {
		display: none;
	}
	.editing {
		cursor: default;
	}
	.editing:hover {
		background: none;
	}
	input {
		flex: 1;
		min-width: 0;
		height: 1.3rem;
		padding: 0 0.3rem;
		border: 1px solid var(--accent);
		border-radius: 0.25rem;
		background: var(--black);
		color: var(--white);
		font: inherit;
		outline: none;
	}
	input[aria-invalid] {
		border-color: var(--red-high);
	}
	.error-hint {
		margin: 0.1rem 0.4rem 0.3rem calc(1.9rem + var(--depth) * 0.9rem);
		padding: 0.25rem 0.4rem;
		border-radius: 0.25rem;
		background: var(--red-low);
		color: var(--red-high);
		font-size: 0.75rem;
	}
</style>
