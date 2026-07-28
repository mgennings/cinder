<script lang="ts">
	// One live region for a whole sequence, so a screen reader hears each phase
	// once instead of a stream of percentage changes. The bar is determinate only
	// while real bytes are moving.
	import type { Snippet } from 'svelte';
	import ProgressBar from '../atoms/ProgressBar.svelte';

	let {
		label,
		value = undefined,
		cancel = undefined
	}: {
		label: string;
		/** 0..1 while uploading; omitted for phases with no measurable progress. */
		value?: number;
		/** Only offered where cancelling is actually safe. */
		cancel?: Snippet;
	} = $props();
</script>

<p aria-live="polite" class="mb-2 text-xs text-mist">{label}</p>
<ProgressBar {label} {value} />
{#if cancel}{@render cancel()}{/if}
