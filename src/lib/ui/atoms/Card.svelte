<script lang="ts">
	// A surface lifted off the vault floor. The depth recipe lives in one CSS
	// rule; this is the one place markup asks for it, so a future change to how
	// Cinder stacks surfaces is a single edit rather than eleven.
	import type { Snippet } from 'svelte';

	let {
		as = 'div',
		class: extra = '',
		children
	}: {
		/** `section` where the card is a landmark region, `div` where it is only a surface. */
		as?: 'div' | 'section';
		class?: string;
		children: Snippet;
	} = $props();
</script>

<svelte:element this={as} class="card {extra}">{@render children()}</svelte:element>
