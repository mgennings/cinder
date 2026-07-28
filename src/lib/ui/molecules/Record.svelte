<script lang="ts">
	// The instrument face the rows are printed on. It states things the system
	// actually did — there is no decorative telemetry here and there must never
	// be, because the whole product is a promise and a fabricated status line
	// would be the single most damaging thing on the page.
	import type { Snippet } from 'svelte';

	let { class: extra = '', children }: { class?: string; children: Snippet } = $props();
</script>

<div class="record {extra}">{@render children()}</div>
