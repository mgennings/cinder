<script lang="ts">
	// The quietest thing that can still be pressed. `.link-quiet` holds the 44px
	// hit area, so this is never a bare <a> with a hover color.
	import type { Snippet } from 'svelte';
	import type { HTMLAnchorAttributes, HTMLButtonAttributes } from 'svelte/elements';

	let {
		href = undefined,
		class: extra = '',
		children,
		...rest
	}: { href?: string; class?: string; children: Snippet } & HTMLAnchorAttributes &
		HTMLButtonAttributes = $props();
</script>

{#if href}
	<a {href} class="link-quiet {extra}" {...rest}>{@render children()}</a>
{:else}
	<button type="button" class="link-quiet {extra}" {...rest}>{@render children()}</button>
{/if}
