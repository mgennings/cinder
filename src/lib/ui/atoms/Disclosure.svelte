<script lang="ts">
	// A detail somebody may want and nobody should have to read. Native
	// `<details>`/`<summary>`: keyboard operable, announced as expandable, and
	// open-by-default when printed or searched, with no script and no focus
	// trap to get wrong. A custom tooltip would owe all of that back, and a
	// hover tooltip would owe it twice on a phone, where there is no hover.
	//
	// The summary is a real question in the reader's words, because that is
	// what makes an unopened row worth scanning past.
	import type { Snippet } from 'svelte';

	let {
		summary,
		class: extra = '',
		children
	}: {
		/** The question, in the reader's words. Kept short enough not to wrap twice. */
		summary: string;
		class?: string;
		children: Snippet;
	} = $props();
</script>

<details class="disclosure {extra}">
	<!-- min-h-11 is the 44px touch target; the marker is the only affordance
	     that says "there is more here", so it never falls below it. -->
	<summary class="flex min-h-11 cursor-pointer items-center gap-2 text-xs text-ghost">
		<span
			aria-hidden="true"
			class="grid size-4 shrink-0 place-content-center rounded-full border border-current text-[0.6rem] leading-none"
		>i</span>
		<span class="underline decoration-dotted underline-offset-4">{summary}</span>
	</summary>
	<div class="pb-1 text-xs leading-relaxed text-mist text-pretty">
		{@render children()}
	</div>
</details>

<style>
	/* The default triangle duplicates the "i" affordance and lands the text
	   inconsistently across engines, so the summary draws its own. */
	.disclosure summary::-webkit-details-marker {
		display: none;
	}
	.disclosure summary {
		list-style: none;
	}
</style>
