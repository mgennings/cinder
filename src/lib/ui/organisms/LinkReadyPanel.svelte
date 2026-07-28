<script lang="ts">
	// THE ARRIVAL. One link, and the two sentences that are true about it.
	//
	// The heading takes focus the moment it mounts: without that a keyboard user
	// is silently returned to the top of the document at the exact moment the
	// thing they came for is on screen.
	import Card from '../atoms/Card.svelte';
	import QuietLink from '../atoms/QuietLink.svelte';
	import CopyLink from '../molecules/CopyLink.svelte';

	let {
		link,
		onreset
	}: {
		link: string;
		onreset: () => void;
	} = $props();

	let heading: HTMLElement | null = $state(null);
	$effect(() => {
		if (link) heading?.focus();
	});
</script>

<Card as="section" class="p-6">
	<h2 bind:this={heading} tabindex="-1" class="mb-1 text-sm font-semibold text-ember-ink outline-none">
		Your one-time link is ready
	</h2>
	<p class="mb-4 text-xs text-ghost">Opening is safe. Reveal removes Cinder's stored copy.</p>
	<CopyLink {link} />
	<QuietLink class="mt-5 text-xs" onclick={onreset}>Send something else</QuietLink>
</Card>
