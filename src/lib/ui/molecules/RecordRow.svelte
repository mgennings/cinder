<script lang="ts">
	// ONE LINE OF A READOUT: a mono label hanging off the gutter rule, and a
	// value that carries the meaning.
	//
	// Two rules live here so no caller has to remember them. `data` is for a
	// value the machine READ — a filename, a byte count, a piece count — and sets
	// it in the instrument face. Everything else stays prose type, because a
	// claim about what the server did, set in mono, borrows an authority it
	// should have to earn in words. And `mark` is reinforcement only: the WORD
	// beside the lamp is always the status.
	import type { Snippet } from 'svelte';

	let {
		label,
		mark = false,
		data = false,
		stacked = false,
		title = undefined,
		class: extra = '',
		children
	}: {
		label: string;
		/** The status lamp. Never the only signal. */
		mark?: boolean;
		/** A measurement rather than a claim. */
		data?: boolean;
		/** Label above value, left aligned — for values too long to sit opposite. */
		stacked?: boolean;
		title?: string;
		class?: string;
		children: Snippet;
	} = $props();
</script>

<div class="record-row {stacked ? 'flex-col items-start gap-1' : ''}">
	<span class="record-label">{label}</span>
	<span
		class="record-value {data ? 'record-data' : ''} {stacked ? '!text-left' : ''} {extra}"
		{title}
	>
		{#if mark}<span class="record-mark"></span>{/if}{@render children()}
	</span>
</div>
