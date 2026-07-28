<script lang="ts">
	// A section title with a hairline running out from it to the edge of the
	// measure. The rule carries the structure that a subtitle would otherwise
	// have to say, which is why it costs zero words.
	import type { Snippet } from 'svelte';

	let {
		level = 2,
		class: extra = '',
		id = undefined,
		children
	}: {
		level?: 2 | 3;
		class?: string;
		id?: string;
		children: Snippet;
	} = $props();
</script>

<svelte:element this={`h${level}`} {id} class="rule-head text-lg font-semibold text-ember-ink {extra}">
	{@render children()}
</svelte:element>
