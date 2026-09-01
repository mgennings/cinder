<script lang="ts">
	// THE EXTENSION DOORS. A yes-and by construction, never a paywall ambush:
	// the prompt appears with time still on the clock, every minute already
	// there is never at risk, and a zero balance is a state with two open doors
	// (the sender's prepaid taps, or a human ask) rather than a checkout wall.
	// Copy is docs/ephemeral-video-design.md's, verbatim.
	import Button from '../atoms/Button.svelte';
	import PulseDot from '../atoms/PulseDot.svelte';
	import type { ExtensionState } from '$lib/video/types';

	let {
		extensions,
		remaining,
		busy,
		noCredits,
		onextend
	}: {
		extensions: ExtensionState;
		/** Whole seconds until the server deadline. */
		remaining: number;
		busy: boolean;
		/** The extend answered 402, or no grant could be minted. */
		noCredits: boolean;
		onextend: () => void;
	} = $props();

	// With time still on the clock, on purpose — so zero is a chosen outcome.
	const twoMinuteCall = $derived(remaining > 0 && remaining <= 120);
</script>

<div class="text-center">
	{#if twoMinuteCall && extensions.canExtend}
		<!-- text-balance, not text-pretty: verbatim copy, so the measure is the
		     only knob against a stranded short last line (flagged at 375). -->
		<p class="text-sm leading-relaxed text-body text-balance" role="status">
			Two minutes left on Cinder's copy. Add time if you need it. What you have already watched stays available until the clock runs out.
		</p>
	{/if}

	{#if !extensions.canExtend}
		<p class="text-sm text-mist text-pretty">This video has all the time it can be given.</p>
	{:else if noCredits}
		<p class="text-sm leading-relaxed text-mist text-pretty" role="status">
			No credits here, and that is okay. Every minute still on the clock is yours. If you need longer, ask the person who sent it to add time from their side, or add credits to an account.
		</p>
		<Button href="/pro" class="mt-4 px-5 py-3 text-sm">Add credits to an account</Button>
	{:else}
		<Button variant="ember" onclick={onextend} disabled={busy} class="mt-4 w-full py-3 text-sm">
			{#if busy}
				<PulseDot class="bg-black/70" />
				Adding time…
			{:else}
				Add 8 minutes
			{/if}
		</Button>
		{#if extensions.prepaidRemaining > 0}
			<p class="mt-2 text-xs text-ghost">
				Prepaid by the sender: {extensions.prepaidRemaining} left, no account needed.
			</p>
		{/if}
	{/if}
</div>
