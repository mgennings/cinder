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
	import Disclosure from '../atoms/Disclosure.svelte';
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

<!-- The story before the control. Someone arriving here has never used this
     and cannot act until they know what the thing does, so two plain lines
     say it, and every qualification waits behind a question further down. -->
<div class="mt-4">
	<p class="text-sm font-medium text-body text-balance">Send a video that deletes&nbsp;itself.</p>
	<p class="mt-1 text-sm leading-relaxed text-mist text-pretty">
		They watch it, and then Cinder destroys its copy. No download, no forwardable file, and
		nothing left sitting in their messages.
	</p>
</div>

<div class="mt-6">
	<label for="video-input" class="mb-2 block text-sm text-mist"> Choose a video </label>
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
		with your camera. Up to {maxLabel}.
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
		<!-- The name gets its own block because the native control truncates it
		     from the right and eats a long one entirely, and because inline it
		     strands itself as the last line of the size sentence (flagged by
		     audit-web-typography at 320). Size and piece count share one line:
		     they are one fact about the same file, and as two lines they read
		     as two separate things to check. -->
		<p in:fade={{ duration: dur(200) }} class="mt-2 text-xs break-all text-mist">{file.name}</p>
		<p in:fade={{ duration: dur(200) }} class="mt-1 text-xs text-ghost">
			{humanSize(file.size)} · {segments}
			encrypted {segments === 1 ? 'piece' : `pieces of up to ${segmentLabel}`}
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
	<Disclosure summary="What is prepaid time?" class="mt-1">
		Extra minutes your person can add with one tap, with no account and no card of their own.
		Each {extensionMinutes}-minute extension costs you 1 credit now, whether or not they use it.
	</Disclosure>
</fieldset>

{#if file}
	<!-- The disclosure, restructured on Matt's instruction 2026-09-01: the wall
	     of prose it used to be was correct and unreadable, which is a defect in
	     a surface somebody meets once. Every fact from the design doc's send
	     screen is still HERE and still on screen before anything encrypts — the
	     two that decide whether to press the button stay visible, and the rest
	     sit one tap away under the question a person would actually ask. Do not
	     quietly drop a fact to make this shorter; move it under a question. -->
	<div in:fade={{ duration: dur(200) }} class="mt-4">
		<p class="text-sm text-body">
			{totalCredits} credits{#if Number(prepaid) > 0}, including {prepaid} prepaid extensions{/if}{credits ===
			null
				? ''
				: `, out of the ${creditWord(credits)} on this account`}.
		</p>
		<p class="mt-1 text-xs leading-relaxed text-ghost text-pretty">
			Cinder never sees the video, its name, or your key.
		</p>

		<div class="mt-2 divide-y divide-line/60 border-y border-line/60">
			<Disclosure summary="What does the other person get?">
				A link that opens to a short explanation and two buttons: watch, or destroy it unwatched.
				When they press play they get up to 64 minutes to watch, lose their connection, come back,
				and rewatch. When they finish, they get {extensionMinutes} more minutes, and either of you can
				add time. There is no download and no keepable link, and you only ever see that it is gone,
				never whether they watched or declined.
			</Disclosure>
			<Disclosure summary="Can they save a copy anyway?">
				They can record their screen or point another phone at it, and no app on earth can stop
				that. Cinder will not pretend otherwise. What Cinder promises is narrower and real: no
				copy exists unless a person deliberately makes one, and nothing is left behind in a chat
				log or a photo backup.
			</Disclosure>
			<Disclosure summary="What happens to my credits?">
				They are spent when Cinder hands you the link, not when the video is watched, so they are
				already gone by the time the pieces finish uploading. If the upload stops partway,
				resuming costs nothing more. Nothing is refunded if the video is never opened, because
				Cinder cannot see who opened what. If nobody opens it, it is destroyed at the expiry you
				chose above.
			</Disclosure>
		</div>
	</div>
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
		<!-- "Stopped", not "the connection dropped": the client cannot tell a lost
		     connection from a refused request, and naming a cause it did not
		     observe sends people to check their wifi when the fault is here. It
		     said "dropped" while a CSP was refusing every upload, which cost real
		     time on 2026-09-01. -->
		<Alert class="mt-3">
			The upload stopped at piece {upload.confirmed + 1} of {upload.segments}. Nothing is lost and
			nothing more is charged: resuming continues from the last confirmed piece.
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
