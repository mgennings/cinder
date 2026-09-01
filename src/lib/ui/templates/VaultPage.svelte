<script lang="ts">
	// THE SIGNATURE PAGE: one card, centered on the vault floor, with the ember
	// glow and the steerable signal terrain behind it. Every page where a person
	// is doing the thing Cinder is for — sending, revealing — is this shape.
	//
	// `.vault-glow` already owns `position: relative` and `overflow: hidden`, and
	// that is load-bearing rather than tidy: the glow is inset -10% on three
	// sides, so a page that clips it in its own class list is a page that can
	// forget to. Nothing here re-states either.
	import type { Snippet } from 'svelte';
	import { terrain } from '../terrain';

	let {
		header = undefined,
		children
	}: {
		header?: Snippet;
		children: Snippet;
	} = $props();
</script>

<main
	id="main-content"
	{@attach terrain()}
	class="vault-glow flex min-h-screen flex-col items-center justify-center px-[clamp(16px,5.33vw,20px)] py-16"
>
	<div class="relative w-full max-w-lg">
		{#if header}
			<header class="mb-8 text-center">{@render header()}</header>
		{/if}
		{@render children()}
	</div>
</main>
