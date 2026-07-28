<script lang="ts">
	// Cinder, with the ember period. The period is the whole logo, so it is never
	// re-typed by hand — a wordmark that drifts is a brand that drifts.
	let {
		as = 'link',
		class: extra = ''
	}: {
		/** `heading` on the page it names, `link` everywhere else. */
		as?: 'heading' | 'link';
		class?: string;
	} = $props();
</script>

{#if as === 'heading'}
	<h1 class="text-3xl font-bold tracking-tight {extra}">Cinder<span class="text-ember">.</span></h1>
{:else}
	<!--
		A 44px target, because this is the way back to the start of the product
		and it was measuring 29 to 40px tall on six routes. `inline-flex` plus a
		min-height rather than padding, so the box grows without moving the
		wordmark off its optical baseline.
	-->
	<a
		href="/"
		class="inline-flex min-h-11 items-center text-2xl font-bold tracking-tight {extra}"
		>Cinder<span class="text-ember">.</span></a
	>
{/if}
