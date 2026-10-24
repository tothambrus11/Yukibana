<!--
  How Run runs a C++ program built for a Linux target (cpp-targets.ts,
  RunOptions): in Linux under QEMU's system emulation (the default) or with
  QEMU's user mode, on how many CPUs, and whether its system calls are
  traced. A button in the top bar that opens a small popover; the choice is
  saved with the project.
-->
<script lang="ts">
	import type { Workspace } from '../workspace.svelte';

	let { workspace }: { workspace: Workspace } = $props();

	let open = $state(false);
	let root: HTMLElement | undefined = $state();
	const options = $derived(workspace.runOptions);
	const summary = $derived(options.emulation === 'user' ? 'User mode' : `Linux, ${options.cpus} CPU${options.cpus > 1 ? 's' : ''}`);

	$effect(() => {
		if (!open) return;
		// Closes on a click outside, or Escape, as a menu does.
		const outside = (e: PointerEvent) => {
			if (root && e.target instanceof Node && !root.contains(e.target)) open = false;
		};
		const escape = (e: KeyboardEvent) => {
			if (e.key === 'Escape') open = false;
		};
		document.addEventListener('pointerdown', outside, true);
		document.addEventListener('keydown', escape);
		return () => {
			document.removeEventListener('pointerdown', outside, true);
			document.removeEventListener('keydown', escape);
		};
	});
</script>

<div class="run-options" bind:this={root}>
	<button class="toggle" aria-expanded={open} aria-haspopup="dialog" onclick={() => (open = !open)} title="How Run runs the program on this Linux target: emulation, CPUs, strace">
		<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 4h12M2 8h12M2 12h12" /><circle cx="5" cy="4" r="1.5" /><circle cx="11" cy="8" r="1.5" /><circle cx="7" cy="12" r="1.5" /></svg>
		{summary}{options.strace ? ', strace' : ''}
	</button>
	{#if open}
		<div class="popover" role="dialog" aria-label="Run options">
			<fieldset>
				<legend>Emulation</legend>
				<label>
					<input type="radio" name="emulation" value="system" checked={options.emulation === 'system'} onchange={() => workspace.setRunOptions({ emulation: 'system' })} />
					<span>System: Linux in QEMU<small>The real Linux kernel: signals, threads on several CPUs, /proc.</small></span>
				</label>
				<label>
					<input type="radio" name="emulation" value="user" checked={options.emulation === 'user'} onchange={() => workspace.setRunOptions({ emulation: 'user' })} />
					<span>User mode (experimental)<small>QEMU translates system calls itself: smaller and starts sooner, but no kernel underneath: one CPU, no fork, and a null dereference reads 0 instead of crashing.</small></span>
				</label>
			</fieldset>
			<label class="row" title={options.emulation === 'user' ? 'User mode emulates one CPU' : 'The guest’s CPUs'}>
				<span>CPUs</span>
				<select value={String(options.cpus)} disabled={options.emulation === 'user'} onchange={(e) => workspace.setRunOptions({ cpus: Number(e.currentTarget.value) as 1 | 2 | 4 })}>
					<option value="1">1</option>
					<option value="2">2</option>
					<option value="4">4</option>
				</select>
			</label>
			<label class="row">
				<span>strace<small>Show the program's system calls in the terminal, dimmed.</small></span>
				<input type="checkbox" checked={options.strace} onchange={(e) => workspace.setRunOptions({ strace: e.currentTarget.checked })} />
			</label>
		</div>
	{/if}
</div>

<style>
	.run-options {
		position: relative;
	}
	.toggle {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
		height: 2rem;
		padding: 0 0.7rem;
		border: 1px solid var(--gray-5);
		border-radius: 0.35rem;
		background: var(--gray-6);
		color: var(--gray-2);
		font: inherit;
		font-size: 0.85rem;
		white-space: nowrap;
		cursor: pointer;
	}
	.toggle:hover,
	.toggle[aria-expanded='true'] {
		border-color: var(--gray-4);
		color: var(--white);
	}
	.toggle svg {
		width: 0.85rem;
		height: 0.85rem;
		fill: var(--gray-6);
		stroke: currentColor;
		stroke-width: 1.4;
	}
	.popover {
		position: absolute;
		top: calc(100% + 0.35rem);
		left: 0;
		z-index: 20;
		display: grid;
		gap: 0.7rem;
		width: 19rem;
		padding: 0.8rem 0.9rem;
		border: 1px solid var(--gray-5);
		border-radius: 0.5rem;
		background: var(--gray-6);
		box-shadow: 0 0.5rem 1.5rem rgb(0 0 0 / 0.3);
		color: var(--gray-2);
		font-size: 0.85rem;
	}
	fieldset {
		display: grid;
		gap: 0.5rem;
		margin: 0;
		padding: 0;
		border: 0;
	}
	legend {
		margin-bottom: 0.4rem;
		color: var(--white);
		font-weight: 600;
	}
	fieldset label {
		display: flex;
		align-items: flex-start;
		gap: 0.5rem;
		cursor: pointer;
	}
	fieldset input {
		margin-top: 0.2rem;
	}
	small {
		display: block;
		color: var(--gray-3);
		font-size: 0.75rem;
		line-height: 1.35;
	}
	.row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
		color: var(--white);
	}
	.row select {
		height: 1.7rem;
		padding: 0 0.4rem;
		border: 1px solid var(--gray-5);
		border-radius: 0.35rem;
		background: var(--gray-6);
		color: var(--white);
		font: inherit;
	}
	.row select:disabled {
		opacity: 0.5;
	}
</style>
