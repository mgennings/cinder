<script lang="ts">
	// The file button inside the field is styled here once. Its `file:` utilities
	// are the only place Tailwind's pseudo-element variants earn their keep, and
	// leaving them in a route means the next route invents a different one.
	import type { HTMLInputAttributes } from 'svelte/elements';

	let { class: extra = '', ...rest }: { class?: string } & HTMLInputAttributes = $props();
</script>

<input
	type="file"
	class="field cursor-pointer px-4 py-3 text-sm file:mr-3 file:cursor-pointer file:rounded-md file:border-0 file:bg-ink-raised file:px-3 file:py-1.5 file:text-sm file:font-semibold file:text-body {extra}"
	{...rest}
/>
