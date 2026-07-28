<script lang="ts">
	// A ruled section of claims. The security page argues three times in this
	// exact shape and the account page a fourth, and each copy was its own
	// three-line block of markup — which is how one of them ends up with a
	// different heading level or a different card padding than the others.
	import RuleHead from '../atoms/RuleHead.svelte';
	import TruthCard from '../molecules/TruthCard.svelte';

	let {
		title,
		rows,
		class: extra = 'mt-10'
	}: {
		title: string;
		rows: { title: string; body: string }[];
		class?: string;
	} = $props();
</script>

<RuleHead class={extra}>{title}</RuleHead>
<div class="mt-4 space-y-4">
	{#each rows as row (row.title)}
		<TruthCard title={row.title} body={row.body} />
	{/each}
</div>
