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
			class="min-w-0 flex-1 truncate rounded-xl border border-line bg-ink px-4 py-3 font-mono text-sm text-ember-soft focus:outline-none"
		/>
		<button
			onclick={copy}
			class="shrink-0 rounded-xl bg-ember px-4 py-3 text-sm font-semibold text-black shadow-[0_4px_20px_-4px_rgba(255,107,74,0.5)] transition-all hover:scale-[1.03] hover:bg-ember-soft active:scale-95"
		>
			{copied ? 'Copied' : 'Copy'}
		</button>
	</div>

	<p class="text-xs leading-relaxed text-ghost">
		Anyone with this link can read the note once, then it's gone. Share it over a channel you
		trust — the link is the only key, and we can't recover it.
	</p>
</div>
