<script lang="ts">
	import type { HTMLTextareaAttributes } from 'svelte/elements';

	let {
		value = $bindable(''),
		class: extra = 'px-4 py-3 text-base leading-relaxed',
		...rest
	}: { value?: string; class?: string } & HTMLTextareaAttributes = $props();
</script>

<textarea bind:value class="field {extra}" {...rest}></textarea>
