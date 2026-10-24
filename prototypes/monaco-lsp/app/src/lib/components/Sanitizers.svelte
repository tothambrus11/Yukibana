<!--
  The C and C++ sanitizers (cpp-sanitizers.ts): AddressSanitizer and
  UndefinedBehaviorSanitizer, each a checkbox that rewrites the -fsanitize=
  line of compile_flags.txt. A button in the top bar that opens a small
  popover, as RunOptions does; the button says which are on.
-->
<script lang="ts">
	import { SANITIZERS, type SanitizerId } from '../cpp-sanitizers';
	import type { Workspace } from '../workspace.svelte';

	let { workspace }: { workspace: Workspace } = $props();

	let open = $state(false);
	let root: HTMLElement | undefined = $state();
	const choice = $derived(workspace.sanitizers ?? { address: false, undefined: false });
	const summary = $derived(
		choice.address && choice.undefined ? 'ASan + UBSan' : choice.address ? 'ASan' : choice.undefined ? 'UBSan' : 'Sanitizers'
	);

	const toggle = (id: SanitizerId, on: boolean) => workspace.chooseSanitizers({ ...choice, [id]: on });

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

<div class="sanitizers" bind:this={root}>
	<button
		class="toggle"
		class:on={choice.address || choice.undefined}
		aria-expanded={open}
		aria-haspopup="dialog"
		onclick={() => (open = !open)}
		title="Sanitizers: check memory accesses and undefined behaviour while the program runs (the -fsanitize= line of compile_flags.txt)"
	>
		<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.5 2.5 3.5v4c0 3.3 2.3 5.9 5.5 7 3.2-1.1 5.5-3.7 5.5-7v-4z" /><path d="m5.5 8 1.8 1.8L10.8 6.3" /></svg>
		{summary}
	</button>
	{#if open}
		<div class="popover" role="dialog" aria-label="Sanitizers">
			{#each SANITIZERS as s (s.id)}
				<label>
					<input type="checkbox" checked={choice[s.id]} onchange={(e) => toggle(s.id, e.currentTarget.checked)} />
					<span>{s.label} <code>-fsanitize={s.id}</code><small>{s.finds}</small></span>
				</label>
			{/each}
			<p>Reports go to the terminal with the file and line. The program runs slower, and its first Run downloads the sanitizer's runtime.</p>
		</div>
	{/if}
</div>

<style>
	.sanitizers {
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
	.toggle[aria-expanded='true'],
	.toggle.on {
		border-color: var(--gray-4);
		color: var(--white);
	}
	.toggle svg {
		width: 0.85rem;
		height: 0.85rem;
		fill: none;
		stroke: currentColor;
		stroke-width: 1.4;
		stroke-linejoin: round;
	}
	.popover {
		position: absolute;
		top: calc(100% + 0.35rem);
		left: 0;
		z-index: 20;
		display: grid;
		gap: 0.7rem;
		width: 21rem;
		padding: 0.8rem 0.9rem;
		border: 1px solid var(--gray-5);
		border-radius: 0.5rem;
		background: var(--gray-6);
		box-shadow: 0 0.5rem 1.5rem rgb(0 0 0 / 0.3);
		color: var(--white);
		font-size: 0.85rem;
	}
	label {
		display: flex;
		align-items: flex-start;
		gap: 0.5rem;
		cursor: pointer;
	}
	input {
		margin-top: 0.2rem;
	}
	code {
		color: var(--gray-3);
		font-size: 0.75rem;
	}
	small,
	p {
		display: block;
		margin: 0;
		color: var(--gray-3);
		font-size: 0.75rem;
		line-height: 1.35;
	}
</style>
