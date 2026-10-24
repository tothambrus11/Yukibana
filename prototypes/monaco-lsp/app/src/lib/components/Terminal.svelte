<!--
  The program's terminal: what it printed (errors in red, and the colours
  the program asked for with ANSI escapes, see ansi.ts), its system calls
  when strace is on (dimmed), what was typed, and an input line. Enter sends the line; Ctrl+D ends the input.
-->
<script lang="ts">
	import type { Workspace } from '../workspace.svelte';

	let { workspace }: { workspace: Workspace } = $props();
	const runner = $derived(workspace.runner);

	let scroller: HTMLDivElement | undefined = $state();
	let field: HTMLInputElement | undefined = $state();
	let line = $state('');
	let follow = true;

	$effect(() => {
		// Follow the output while the user has not scrolled up.
		for (const c of runner.chunks) void c.text.length;
		if (scroller && follow) scroller.scrollTop = scroller.scrollHeight;
	});

	const waiting = $derived(runner.state.kind === 'running' && runner.state.waiting);
	$effect(() => {
		if (waiting) field?.focus();
	});

	function keydown(e: KeyboardEvent) {
		if (e.key === 'Enter') {
			e.preventDefault();
			runner.input(line);
			line = '';
		} else if (e.key === 'd' && e.ctrlKey && line === '') {
			e.preventDefault();
			runner.endInput();
		}
	}

	const status = $derived.by(() => {
		const s = runner.state;
		switch (s.kind) {
			case 'idle':
				return '';
			case 'loading':
				return `Downloading ${s.label}${s.total ? ` ${Math.round((100 * s.loaded) / s.total)}%` : ''}`;
			case 'running':
				return s.waiting ? 'Waiting for input' : `${s.phase}…`;
			case 'ended':
				return `${s.code === null ? 'Stopped' : `Exited with code ${s.code}`} after ${s.seconds.toFixed(1)} s`;
		}
	});
</script>

<div class="terminal">
	<div class="lines" bind:this={scroller} onscroll={(e) => {
		const el = e.currentTarget;
		follow = el.scrollTop + el.clientHeight >= el.scrollHeight - 4;
	}}>
		{#if runner.chunks.length === 0 && runner.state.kind === 'idle'}
			<p class="empty">Press <strong>Run</strong> (Ctrl+Enter) to run the project. Its output appears here.</p>
		{/if}
		<pre>{#each runner.chunks as chunk (chunk.id)}<span class={chunk.kind} style={chunk.style || undefined}>{chunk.text}</span>{/each}</pre>
	</div>
	{#if runner.busy}
		<label class="input" class:waiting>
			<span class="prompt" aria-hidden="true">›</span>
			<span class="sr-only">Input for the program</span>
			<input bind:this={field} bind:value={line} onkeydown={keydown} spellcheck="false" autocomplete="off" placeholder={waiting ? 'The program is waiting for input' : 'Input (Enter to send, Ctrl+D to end)'} />
		</label>
	{/if}
	<div class="footer">
		<span class="status" class:failed={runner.state.kind === 'ended' && runner.state.code !== 0}>{status}</span>
		<button class="clear" title="Clear the terminal" onclick={() => runner.clear()}>Clear</button>
	</div>
</div>

<style>
	.terminal {
		display: flex;
		flex-direction: column;
		height: 100%;
	}
	.lines {
		flex: 1;
		min-height: 0;
		overflow: auto;
		padding: 0.5rem 1rem;
	}
	pre {
		margin: 0;
		font-family: var(--font-mono);
		font-size: 0.8rem;
		line-height: 1.55;
		white-space: pre-wrap;
		word-break: break-word;
		color: var(--white);
	}
	.stderr {
		color: var(--red-high);
	}
	.stdin {
		color: var(--accent-high);
	}
	.info {
		color: var(--gray-3);
		font-style: italic;
	}
	/* System calls (strace on a Linux target): there to read when wanted, not to compete with the output. */
	.trace {
		color: var(--gray-4);
		font-style: italic;
	}
	.empty {
		margin: 0.2rem 0;
		color: var(--gray-3);
		font-size: 0.8125rem;
	}
	.input {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		margin: 0 0.75rem 0.4rem;
		padding: 0 0.6rem;
		border: 1px solid var(--gray-5);
		border-radius: 0.35rem;
		background: var(--gray-6);
	}
	.input.waiting {
		border-color: var(--accent-high);
	}
	.prompt {
		color: var(--accent-high);
		font-family: var(--font-mono);
	}
	.input input {
		flex: 1;
		min-width: 0;
		height: 1.9rem;
		border: 0;
		outline: 0;
		background: none;
		color: var(--white);
		font-family: var(--font-mono);
		font-size: 0.8rem;
	}
	.footer {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		padding: 0.25rem 1rem;
		border-top: 1px solid var(--gray-5);
		color: var(--gray-3);
		font-size: 0.75rem;
		min-height: 1.9rem;
	}
	.status.failed {
		color: var(--red-high);
	}
	.clear {
		padding: 0.1rem 0.55rem;
		border: 1px solid var(--gray-5);
		border-radius: 0.35rem;
		background: var(--gray-6);
		color: var(--gray-2);
		font: inherit;
		cursor: pointer;
	}
	.clear:hover {
		color: var(--white);
	}
	.sr-only {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip: rect(0 0 0 0);
	}
</style>
