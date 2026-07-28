<script lang="ts">
	// AN ENDING. Every terminal state of a one-time link is this shape: a heading
	// that takes focus, a paragraph that says exactly what happened, and one way
	// onward.
	//
	// The heading is `tabindex="-1"` and bound out to the page because focus has
	// to land somewhere deliberate after the view changes — otherwise a keyboard
	// user is silently returned to the top of the document right after the most
	// consequential action on the site.
	import type { Snippet } from 'svelte';

	let {
		title,
		heading = $bindable(null),
		children,
		action
	}: {
		title: string;
		heading?: HTMLElement | null;
		/** The paragraph. A snippet, because several of these branch on part count. */
		children: Snippet;
		/** The one way onward. */
		action?: Snippet;
	} = $props();
</script>

<div class="text-center">
	<h1 bind:this={heading} tabindex="-1" class="text-lg font-semibold outline-none">{title}</h1>
	<p class="mt-2 text-sm text-mist">{@render children()}</p>
	{#if action}{@render action()}{/if}
</div>
