<script lang="ts">
	// Real radios underneath, filling the whole option, so a pointer, a keyboard,
	// and an automated click all land on the same element. The legend is the
	// question; it is screen-reader-only because the options answer it visibly.
	let {
		legend,
		name,
		options,
		value = $bindable(''),
		disabled = false
	}: {
		legend: string;
		name: string;
		options: { value: string; label: string }[];
		value?: string;
		disabled?: boolean;
	} = $props();
</script>

<fieldset class="min-w-0">
	<legend class="sr-only">{legend}</legend>
	<div class="seg">
		{#each options as opt (opt.value)}
			<label class="seg-option">
				<input type="radio" {name} value={opt.value} bind:group={value} {disabled} />
				{opt.label}
			</label>
		{/each}
	</div>
</fieldset>
