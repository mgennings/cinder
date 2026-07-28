<script lang="ts">
	// THE ATOM EVERY ACTION IS MADE OF. `.btn` carries the 44px floor, the
	// two-speed motion contract, and the focus halo; the variant carries the
	// voice. Rendering an <a> when `href` is present keeps a navigation a
	// navigation — a button that navigates loses middle-click, copy-link, and
	// the correct role in the accessibility tree.
	import type { Snippet } from 'svelte';
	import type { HTMLAnchorAttributes, HTMLButtonAttributes } from 'svelte/elements';

	type Variant = 'ember' | 'ghost' | 'bare';

	let {
		variant = 'ghost',
		href = undefined,
		class: extra = '',
		children,
		...rest
	}: {
		/** ember = the one glowing action. ghost = quiet secondary. bare = geometry only. */
		variant?: Variant;
		href?: string;
		class?: string;
		children: Snippet;
	} & HTMLButtonAttributes &
		HTMLAnchorAttributes = $props();

	const variantClass: Record<Variant, string> = {
		ember: 'btn-ember',
		ghost: 'btn-ghost',
		bare: ''
	};

	const cls = $derived(['btn', variantClass[variant], extra].filter(Boolean).join(' '));
</script>

{#if href}
	<a {href} class={cls} {...rest}>{@render children()}</a>
{:else}
	<button class={cls} {...rest}>{@render children()}</button>
{/if}
