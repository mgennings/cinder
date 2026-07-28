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
	<a href="/" class="text-2xl font-bold tracking-tight {extra}"
		>Cinder<span class="text-ember">.</span></a
	>
{/if}
