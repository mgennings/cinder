<script lang="ts">
	// THE VIDEO SEND FORM. Everything the sender sees between "Video" and the
	// link, and none of what happens underneath: no crypto, no API, no uploader.
	// The route owns those; this owns the form, the disclosure, and the honest
	// narration of an upload that can stall and resume.
	//
	// The one ordering rule this surface exists to keep: the disclosure — cost,
	// expiry, what "gone" means, and the screen-recording limit — is on screen
	// BEFORE anything encrypts. The button that starts encryption sits below it.
	import { fade } from 'svelte/transition';
	import {
		SEGMENT_BYTES,
		SEND_COST_CREDITS,
		EXTENSION_SECONDS,
		MAX_VIDEO_BYTES,
		type UploadState
	} from '$lib/video/types';
	import { PRO_PRICE, PRO_CREDITS, creditWord } from '$lib/pro';
	import Button from '../atoms/Button.svelte';
	import QuietLink from '../atoms/QuietLink.svelte';
	import Alert from '../atoms/Alert.svelte';
	import Select from '../atoms/Select.svelte';
	import FileInput from '../atoms/FileInput.svelte';
	import SegmentedChoice from '../molecules/SegmentedChoice.svelte';
	import PhaseProgress from '../molecules/PhaseProgress.svelte';
	import { humanSize } from '../format';

	let {
		file,
		segments,
		credits,
		prepaid = $bindable('0'),
		ttl = $bindable('86400'),
		busy,
		encrypting,
		upload,
		error,
		needsCredits,
		dur,
		onpick,
		oncreate,
		onresume,
		oncancel
	}: {
		file: File | null;
		/** How many encrypted pieces this video becomes. */
		segments: number;
		/** null means "we have no idea" — signed out, or a build with no identity API. */
		credits: number | null;
		/** Prepaid extensions for the recipient: '0' | '2' | '4' | '8'. */
		prepaid?: string;
		ttl?: string;
		busy: boolean;
		/** True while the segmenter is opening the file, before upload state exists. */
		encrypting: boolean;
		upload: UploadState | null;
		error: string;
		/** Whether the current error is the one the pay point can resolve. */
		needsCredits: boolean;
		/** Transition duration, already reduced-motion aware. */
		dur: (ms: number) => number;
		onpick: (e: Event) => void;
		oncreate: () => void;
		onresume: () => void;
		oncancel: () => void;
	} = $props();

	const maxLabel = `${Math.round(MAX_VIDEO_BYTES / (1024 * 1024))} MiB`;
	const segmentLabel = `${Math.round(SEGMENT_BYTES / (1024 * 1024))} MiB`;
	const extensionMinutes = EXTENSION_SECONDS / 60;

	const ttlOptions = [
		{ value: '3600', label: '1 hour' },
		{ value: '86400', label: '1 day' },
		{ value: '604800', label: '7 days' }
	];

	// Labeled by what the recipient gets, not by the internal count: 2 prepaid
	// extensions is 16 minutes they can add with taps, no account, no card.
	const prepaidOptions = [
		{ value: '0', label: 'None' },
		{ value: '2', label: '16 min' },
		{ value: '4', label: '32 min' },
		{ value: '8', label: '64 min' }
	];

	// Total cost, computed from the same constants the mint charges against.
	// One credit per prepaid extension, on top of the send.
	const totalCredits = $derived(SEND_COST_CREDITS + Number(prepaid));

	const stalled = $derived(upload?.phase === 'stalled');
	const confirmed = $derived(
		upload && upload.phase !== 'done' ? upload.confirmed : (upload?.segments ?? 0)
	);

	// The camera path: the same native input, with `capture` so a phone opens
	// the camera directly. No custom recorder — the platform's is the honest one.
	let recordInput: HTMLInputElement | null = $state(null);
</script>

<div class="mt-4">
	<label for="video-input" class="mb-2 block text-sm text-mist">
		Choose a video, up to {maxLabel}
	</label>
	<FileInput id="video-input" accept="video/*" onchange={onpick} disabled={busy} />
	<p class="mt-2 text-xs text-ghost text-balance">
		Or
		<button
			type="button"
			class="cursor-pointer underline underline-offset-2"
			disabled={busy}
			onclick={() => recordInput?.click()}
		>
			record one now
		</button>
		with your camera. Either way it is encrypted on this device before anything is sent.
	</p>
	<input
		bind:this={recordInput}
		type="file"
		accept="video/*"
		capture="user"
		class="sr-only"
		aria-label="Record a video with your camera"
		onchange={onpick}
		disabled={busy}
	/>

	{#if file}
		<!-- Size first, same reasoning as the file path: right-truncation was
		     eating it entirely on a long filename. The name is its own block:
		     inline, a long unbreakable filename strands itself as the last line
		     of the size sentence (audit-web-typography flagged it at 320). -->
		<p in:fade={{ duration: dur(200) }} class="mt-2 text-xs text-ghost">
			{humanSize(file.size)} <span class="block break-all">{file.name}</span>
		</p>
		<p in:fade={{ duration: dur(200) }} class="mt-1 text-xs text-mist">
			Sent as {segments}
			encrypted {segments === 1 ? 'piece' : `pieces of up to ${segmentLabel}`}.
		</p>
	{/if}
</div>

<div class="mt-4 flex flex-wrap items-center gap-2 text-sm text-mist">
	<label for="video-ttl">If nobody opens it, destroyed after</label>
	<Select id="video-ttl" options={ttlOptions} bind:value={ttl} disabled={busy} />
</div>

<fieldset class="mt-4" disabled={busy}>
	<div class="mb-2 text-sm text-mist">Prepay extra watch time for them</div>
	<SegmentedChoice
		legend="Prepaid extra watch time"
		name="prepaid"
		options={prepaidOptions}
		bind:value={prepaid}
	/>
	<p class="mt-2 text-xs leading-relaxed text-ghost text-balance">
		Prepaid time your recipient can add with one tap, no account, no card. Each {extensionMinutes}-minute
		extension costs you 1 credit now, whether or not it gets used.
	</p>
</fieldset>

{#if file}
	<!-- The disclosure. VERBATIM from docs/ephemeral-video-design.md, "The send
	     screen, before encryption starts" — one unbroken line, on screen before
	     the button that starts encryption. Do not edit it here; the design doc
	     is the source and the e2e spec pins the order. -->
	<p in:fade={{ duration: dur(200) }} class="mt-4 text-xs leading-relaxed text-mist text-pretty">
		Sending this video costs 2 credits, spent when Cinder hands you the link, not when it is watched. If nobody opens it, it is destroyed at the expiry you choose. Once your person finishes watching, they get 8 more minutes, and either of you can add time. Cinder never sees the video, its name, or your key, and it cannot stop the other side from recording their screen. Nobody can promise that; Cinder is just&nbsp;the&nbsp;one&nbsp;saying&nbsp;so.
	</p>
	<p in:fade={{ duration: dur(200) }} class="mt-2 text-xs text-ghost">
		{#if Number(prepaid) > 0}
			With {prepaid} prepaid extensions: {totalCredits} credits total{credits === null
				? ''
				: `, out of the ${creditWord(credits)} on this account`}.
		{:else}
			{totalCredits} credits total{credits === null
				? ''
				: `, out of the ${creditWord(credits)} on this account`}.
		{/if}
	</p>
	{#if credits === 0}
		<!-- Zero is a state, not a fault. -->
		<p in:fade={{ duration: dur(200) }} class="mt-2 text-xs leading-relaxed text-mist text-pretty">
			This account has no credits left. Notes and files under 4 MiB still send free, the way
			they always have. {PRO_PRICE} adds {PRO_CREDITS} credits.
			<a class="underline underline-offset-2" href="/pro">Top up</a>.
		</p>
	{/if}
{/if}

{#if error}
	<div in:fade={{ duration: dur(200) }}>
		<Alert class="mt-3">
			{error}
			{#if needsCredits}
				<a class="underline underline-offset-2" href="/pro">See what Pro costs</a>.
			{/if}
		</Alert>
	</div>
{/if}

{#if stalled && upload && upload.phase === 'stalled'}
	<!-- A dropped connection is a pause, not a loss: nothing has been promised
	     to anyone yet, and every confirmed piece stays confirmed. -->
	<div in:fade={{ duration: dur(200) }}>
		<Alert class="mt-3">
			The connection dropped at piece {upload.confirmed + 1} of {upload.segments}. Nothing is
			lost: resume continues from the last confirmed piece.
		</Alert>
		<Button variant="ember" onclick={onresume} class="mt-3 w-full py-3 text-sm">
			Resume the upload
		</Button>
	</div>
{:else if busy}
	<div in:fade={{ duration: dur(150) }} class="mt-5">
		<PhaseProgress
			label={encrypting
				? 'Encrypting on this device…'
				: upload && upload.phase === 'uploading'
					? `Uploading encrypted pieces, ${confirmed} of ${upload.segments} confirmed…`
					: 'Sealing the video…'}
			value={upload && upload.phase === 'uploading' ? upload.fraction : undefined}
		>
			{#snippet cancel()}
				{#if upload?.phase === 'uploading'}
					<QuietLink class="mt-3 text-xs" onclick={oncancel}>Cancel</QuietLink>
				{/if}
			{/snippet}
		</PhaseProgress>
	</div>
{:else}
	<Button variant="ember" onclick={oncreate} disabled={!file} class="mt-5 w-full py-3 text-sm">
		Create one-time link
	</Button>
{/if}
