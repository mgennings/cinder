<script lang="ts">
	// Native <progress>, so the platform owns the semantics. `value` is
	// deliberately optional and deliberately NOT passed as undefined: setting the
	// property coerces to 0, which a screen reader reads as "0 percent" under a
	// label that says "verifying".
	let { label, value = undefined }: { label: string; value?: number } = $props();
</script>

{#if value === undefined}
	<progress class="progress" aria-label={label}></progress>
{:else}
	<progress class="progress" aria-label={label} max="1" {value}></progress>
{/if}
