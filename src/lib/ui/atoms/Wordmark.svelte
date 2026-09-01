<script lang="ts">
	import { resolve } from '$app/paths';

	// Cinder, with the ember period. The period is the whole logo, so it is never
	// re-typed by hand — a wordmark that drifts is a brand that drifts.
	let {
		as = 'link',
		mark = false,
		class: extra = ''
	}: {
		/** `heading` on the page it names, `link` everywhere else. */
		as?: 'heading' | 'link';
		/** Add the canonical mark inside the same home-link target. */
		mark?: boolean;
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
		href={resolve('/')}
		aria-label={mark ? 'Cinder home' : undefined}
		class="inline-flex min-h-11 items-center {mark ? 'gap-2' : ''} text-2xl font-bold tracking-tight {extra}"
	>
		{#if mark}
			<picture aria-hidden="true">
				<source media="(prefers-color-scheme: light)" srcset="/brand/cinder-mark-light.svg" />
				<img class="h-8 w-8" src="/brand/cinder-mark.svg" alt="" />
			</picture>
		{/if}
		<span aria-hidden={mark ? 'true' : undefined}>Cinder<span class="text-ember">.</span></span>
	</a>
{/if}
