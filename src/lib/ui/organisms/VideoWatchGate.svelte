<script lang="ts">
	// THE VIDEO GATE. Bot-safe by construction: it fetches nothing, claims
	// nothing, and renders entirely from the link — a preview bot that loads
	// this page gets words and nothing else. The claim happens only when a
	// human presses Start watching.
	//
	// Every sentence here is docs/ephemeral-video-design.md's copy, verbatim.
	// The choice sits above the fold with under 32 words over it; the full
	// honest account (window mechanics, screen recording, no download) is
	// present but below the buttons, not on top of them.
	import Button from '../atoms/Button.svelte';
	import PulseDot from '../atoms/PulseDot.svelte';

	let {
		busy,
		onstart,
		ondecline
	}: {
		/** The claim is in flight. Both doors close while it is. */
		busy: boolean;
		onstart: () => void;
		ondecline: () => void;
	} = $props();
</script>

<div>
	<h1 class="text-center text-lg font-semibold text-balance">Someone sent you a video, for you alone.</h1>

	<!-- text-balance on the short paragraphs, not text-pretty: the copy is the
	     design doc's, verbatim, so the measure is the only knob — balance
	     equalizes the lines, which is what removes the stranded short last line
	     the typography audit flagged at 440. -->
	<p class="mt-3 text-sm leading-relaxed text-mist text-balance">
		When you press play, a watch window opens: you can watch it, lose your connection, come back, and rewatch it.
	</p>

	<Button variant="ember" onclick={onstart} disabled={busy} class="mt-6 w-full py-3 text-sm">
		{#if busy}
			<PulseDot class="bg-black/70" />
			Opening your watch window…
		{:else}
			Start watching
		{/if}
	</Button>

	<Button onclick={ondecline} disabled={busy} class="mt-3 w-full py-3 text-sm">
		Decline and destroy it unwatched
	</Button>

	<p class="mt-2 text-xs leading-relaxed text-ghost text-balance">
		Declining destroys the video without playing it. The sender only ever sees that it is gone, never whether you watched or declined.
	</p>

	<p class="mt-6 border-t border-line pt-4 text-xs leading-relaxed text-mist text-pretty">
		<!-- The trailing non-breaking spaces are display-only: they bind the final
		     words so no width can strand a short last line. The copy itself is
		     byte-for-byte the design doc's. -->
		When the window ends, Cinder destroys its stored copy and this link goes dark for good. There is no download and no keepable link. One honest limit: nothing on the web can stop a screen recording, and Cinder will not pretend otherwise. What Cinder promises is that no copy exists unless someone&nbsp;chooses&nbsp;to&nbsp;make&nbsp;one.
	</p>
</div>
