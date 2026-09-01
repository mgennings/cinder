<script lang="ts">
	// TRUTHFUL DOWNLOAD NARRATION — never a dead spinner. Says which piece is
	// arriving and when playback can honestly start. Playback waits for the
	// whole file on purpose: phone MP4s routinely carry their index at the end,
	// so a partial file is not honestly playable, and Cinder narrates the wait
	// instead of pretending to stream.
	import ProgressBar from '../atoms/ProgressBar.svelte';

	let {
		received,
		segments
	}: {
		/** Pieces decrypted and staged locally so far. */
		received: number;
		segments: number;
	} = $props();

	const assembling = $derived(received >= segments);
</script>

<div class="text-center">
	<h1 class="text-lg font-semibold text-balance">Your watch window is open</h1>

	<div class="mt-4">
		<ProgressBar label="Downloading the video" value={segments > 0 ? received / segments : 0} />
	</div>

	<p class="mt-4 text-sm text-body" role="status">
		{#if assembling}
			All {segments} pieces are here. Putting the video together…
		{:else if segments > 1}
			Piece {received + 1} of {segments} is arriving.
		{:else}
			The video is arriving.
		{/if}
	</p>

	<p class="mt-2 text-xs leading-relaxed text-mist text-pretty">
		Playback starts when the last piece lands. The wait is the download, not a fault. If your connection drops, the pieces already here keep, and the rest resume on their own.
	</p>
</div>
