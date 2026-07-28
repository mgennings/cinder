<script lang="ts">
	// A claim and its explanation. Used wherever the product argues in public —
	// the security page, the account page, the field notes. Heading level is a
	// prop because the same card sits under an h2 on one page and an h3 on
	// another, and a skipped level is a real navigation defect for a screen
	// reader.
	import Card from '../atoms/Card.svelte';

	let {
		title,
		body,
		level = 3,
		class: extra = 'p-4'
	}: { title: string; body: string; level?: 3 | 4; class?: string } = $props();
</script>

<Card class={extra}>
	<svelte:element this={`h${level}`} class={level === 3 ? 'font-medium text-body' : 'text-sm font-medium text-body'}>
		{title}
	</svelte:element>
	<p class="mt-1 text-sm leading-relaxed text-mist">{body}</p>
</Card>
