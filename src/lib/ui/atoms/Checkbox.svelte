<script lang="ts">
	// The LABEL is the hit area, and it is the label that carries min-h-11: the
	// box itself is 20px, and a 20px target measured on the phone is the defect
	// this component exists to make unrepeatable.
	import type { Snippet } from 'svelte';

	let {
		checked = $bindable(false),
		disabled = false,
		children
	}: { checked?: boolean; disabled?: boolean; children: Snippet } = $props();
</script>

<label class="flex min-h-11 cursor-pointer items-center gap-2 text-sm text-mist">
	<input type="checkbox" bind:checked {disabled} class="accent-ember" />
	{@render children()}
</label>
