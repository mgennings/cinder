<script lang="ts">
	import type { Snippet } from 'svelte';
	import DashboardHeader from '../organisms/DashboardHeader.svelte';

	let {
		current,
		location,
		title,
		lede,
		children
	}: {
		current: string;
		location: string;
		title: string;
		lede?: string;
		children: Snippet;
	} = $props();
</script>

<div class="min-h-dvh">
	<DashboardHeader {current} {location} />

	<main id="main-content" class="bench mx-auto w-full max-w-3xl px-5 py-10" tabindex="-1">
		<header class="max-w-2xl">
			<h1 class="text-2xl font-bold">{title}</h1>
			{#if lede}
				<p class="mt-3 leading-relaxed text-mist">{lede}</p>
			{/if}
		</header>

		{@render children()}
	</main>
</div>
