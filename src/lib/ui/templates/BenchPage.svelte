<script lang="ts">
	// THE READING PAGE: security, the field notes, the account, the pay point.
	// Long prose, so the terrain holds the top of the page and is gone before the
	// first paragraph — a grid behind body copy is a legibility bug wearing art
	// direction.
	import type { Snippet } from 'svelte';
	import Wordmark from '../atoms/Wordmark.svelte';

	let {
		wordmark = true,
		pad = 'normal',
		children
	}: {
		wordmark?: boolean;
		/** `tight` for the money pages, which open on a heading rather than a mark. */
		pad?: 'normal' | 'tight';
		children: Snippet;
	} = $props();
</script>

<main class="bench mx-auto w-full max-w-2xl px-5 {pad === 'tight' ? 'py-12' : 'py-16'}">
	{#if wordmark}
		<Wordmark />
	{/if}
	{@render children()}
</main>
