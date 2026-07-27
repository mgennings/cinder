<script lang="ts">
	import { fade } from 'svelte/transition';

	let { link }: { link: string } = $props();
	let copied = $state(false);

	async function copy() {
		await navigator.clipboard.writeText(link);
		copied = true;
		setTimeout(() => (copied = false), 1800);
	}
</script>

<div in:fade={{ duration: 300 }} class="flex flex-col gap-3">
	<div class="flex items-stretch gap-2">
		<input
			readonly
			value={link}
			aria-label="Your one-time link"
			class="field min-w-0 flex-1 truncate px-4 py-3 font-mono text-sm text-ember-soft"
		/>
		<button onclick={copy} class="btn btn-ember shrink-0 px-4 py-3 text-sm">
			{copied ? 'Copied' : 'Copy'}
		</button>
	</div>

	<p class="text-xs leading-relaxed text-ghost">
		One successful reveal removes Cinder's stored copy. Share this link over a channel you trust
		— it is the only key, and anyone who captures it can keep a copy.
	</p>
</div>
