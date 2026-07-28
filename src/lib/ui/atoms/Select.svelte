<script lang="ts">
	// Options are passed as data rather than as slotted markup, because a select
	// whose children are arbitrary is a select whose accessible name can be
	// accidentally built from every option in it.
	import type { HTMLSelectAttributes } from 'svelte/elements';

	let {
		value = $bindable(''),
		options,
		class: extra = 'w-auto px-2 py-1.5 text-sm',
		...rest
	}: {
		value?: string;
		options: { value: string; label: string }[];
		class?: string;
	} & HTMLSelectAttributes = $props();
</script>

<select bind:value class="field {extra}" {...rest}>
	{#each options as opt (opt.value)}
		<option value={opt.value}>{opt.label}</option>
	{/each}
</select>
