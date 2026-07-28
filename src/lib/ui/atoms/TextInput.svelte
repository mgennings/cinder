<script lang="ts">
	// A recessed input. `.field` carries the 44px floor, the inset depth, and the
	// ember focus border, so no caller ever re-specifies any of the three.
	import type { HTMLInputAttributes } from 'svelte/elements';

	let {
		value = $bindable(''),
		class: extra = 'px-4 py-2.5 text-sm',
		element = $bindable(null),
		...rest
	}: {
		value?: string;
		class?: string;
		/** For the pages that must move focus into the field themselves. */
		element?: HTMLInputElement | null;
	} & HTMLInputAttributes = $props();
</script>

<input bind:this={element} bind:value class="field {extra}" {...rest} />
