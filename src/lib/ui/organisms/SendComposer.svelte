<script module lang="ts">
	// The sender's journey, named by what is actually happening. Every one of
	// these is a state a person can be looking at, so each gets real words.
	export type Phase = 'idle' | 'encrypting' | 'uploading' | 'finalizing';
</script>

<script lang="ts">
	// THE COMPOSER. Everything a person touches on the way to a link, and none of
	// what happens after they press it.
	//
	// It holds no key, opens no socket, and calls no API. The crypto and the
	// state machine live in the route; this owns the form, the words around the
	// form, and where focus and live regions go. That line is what lets the whole
	// sending surface be rendered in isolation with nothing running behind it.
	import { fade } from 'svelte/transition';
	import { MAX_FILE_BYTES, MAX_TRANSFER_BYTES } from '$lib/crypto/file-crypto';
	import { PRO_PRICE, PRO_CREDITS, creditWord } from '$lib/pro';
	import Card from '../atoms/Card.svelte';
	import Button from '../atoms/Button.svelte';
	import QuietLink from '../atoms/QuietLink.svelte';
	import Alert from '../atoms/Alert.svelte';
	import TextArea from '../atoms/TextArea.svelte';
	import TextInput from '../atoms/TextInput.svelte';
	import Select from '../atoms/Select.svelte';
	import FileInput from '../atoms/FileInput.svelte';
	import Checkbox from '../atoms/Checkbox.svelte';
	import SegmentedChoice from '../molecules/SegmentedChoice.svelte';
	import PhaseProgress from '../molecules/PhaseProgress.svelte';
	import { humanSize } from '../format';

	let {
		mode = $bindable('note'),
		text = $bindable(''),
		passphrase = $bindable(''),
		usePassphrase = $bindable(false),
		ttl = $bindable('86400'),
		file,
		parts,
		credits,
		videoEnabled,
		busy,
		phase,
		uploaded,
		ready,
		error,
		needsPro,
		dur,
		onpick,
		oncreate,
		oncancel,
		video
	}: {
		mode?: string;
		text?: string;
		passphrase?: string;
		usePassphrase?: boolean;
		ttl?: string;
		file: File | null;
		/** How many pieces this file will be sent in. 1 is the free path. */
		parts: number;
		/** null means "we have no idea" — signed out, or a build with no identity API. */
		credits: number | null;
		/** Whether this tab captured the hidden local-review fragment. */
		videoEnabled: boolean;
		busy: boolean;
		phase: Phase;
		/** 0..1, real bytes on the wire. */
		uploaded: number;
		ready: boolean;
		error: string;
		/** Whether the current error is the one the pay point can resolve. */
		needsPro: boolean;
		/** Transition duration, already reduced-motion aware. */
		dur: (ms: number) => number;
		onpick: (e: Event) => void;
		oncreate: () => void;
		oncancel: () => void;
		/**
		 * The whole video surface, injected by the route. Video is a third
		 * artifact with its own promise, its own cost, and its own disclosure
		 * copy — none of the note/file footer below (ttl, passphrase, the shared
		 * button) applies to it, so the snippet owns everything under the mode
		 * switch and this component renders nothing else in video mode.
		 */
		video?: import('svelte').Snippet;
	} = $props();

	const maxLabel = `${Math.round(MAX_FILE_BYTES / (1024 * 1024))} MiB`;
	const maxProLabel = `${Math.round(MAX_TRANSFER_BYTES / (1024 * 1024))} MiB`;

	const modeOptions = $derived([
		{ value: 'note', label: 'Note' },
		{ value: 'file', label: 'File' },
		...(videoEnabled ? [{ value: 'video', label: 'Video' }] : [])
	]);

	const ttlOptions = [
		{ value: '3600', label: '1 hour' },
		{ value: '86400', label: '1 day' },
		{ value: '604800', label: '7 days' }
	];

	const phaseLabel: Record<Phase, string> = {
		idle: '',
		encrypting: 'Encrypting on this device…',
		finalizing: 'Verifying the stored copy…',
		uploading: 'Uploading encrypted bytes…'
	};
</script>

<Card as="section" class="p-6">
	<SegmentedChoice
		legend="What are you sending?"
		name="mode"
		options={modeOptions}
		bind:value={mode}
		disabled={busy}
	/>

	{#if mode === 'video' && videoEnabled}
		{@render video?.()}
	{:else}
	{#if mode === 'note'}
		<div class="mt-4">
			<TextArea
				bind:value={text}
				aria-label="Your secret note"
				placeholder="Type your secret. It never leaves this device unencrypted."
				rows={6}
				class="resize-none px-4 py-3 text-base leading-relaxed"
			/>
		</div>
	{:else}
		<div class="mt-4">
			<label for="file-input" class="mb-2 block text-sm text-mist">
				Choose one file, up to {maxLabel} — or up to {maxProLabel} with Pro
			</label>
			<FileInput id="file-input" onchange={onpick} disabled={busy} />
			{#if file}
				<!-- Size first: right-truncation was eating it entirely on a long
				     filename, leaving only a name the file input already shows. -->
				<p in:fade={{ duration: dur(200) }} class="mt-2 text-xs text-ghost">
					{humanSize(file.size)} · <span class="break-all">{file.name}</span>
				</p>
				{#if parts > 1}
					<!-- Said here, at the moment the file is chosen, rather than at the
					     moment it fails — and the PRICE is said in the same breath as
					     the piece count, before anything is encrypted. Encrypting 200 MB
					     and then mentioning the cost is the failure mode this avoids.
					     The recipient is shown the same piece count before they press
					     anything. -->
					<p in:fade={{ duration: dur(200) }} class="mt-2 text-xs leading-relaxed text-mist">
						Over {maxLabel}, so this goes in {parts} pieces and costs up to 1 Cinder Pro credit{credits ===
						null
							? ''
							: `, out of the ${creditWord(credits)} on this account`}. Each piece is deleted
						before it is handed over, exactly as one file is. Up to 1, because one credit buys
						about fifteen minutes of permission to send big: anything else you start in that
						window, in this tab, costs nothing more. If any piece fails on the way to your
						recipient, the whole transfer is permanently gone — there is no retry, and the
						credit is spent either way. Cinder cannot see which transfer failed, which is the
						same reason it can never see who you sent it to.
					</p>
					{#if credits === 0}
						<!-- Zero is a state, not a fault. It says what still works before
						     it says what to do about it. -->
						<p in:fade={{ duration: dur(200) }} class="mt-2 text-xs leading-relaxed text-mist">
							This account has no credits left. Nothing is broken — anything under {maxLabel} sends
							free, with no account, the way it always has. {PRO_PRICE} adds {PRO_CREDITS} large
							sends. <a class="underline underline-offset-2" href="/pro">Top up</a>.
						</p>
					{/if}
				{/if}
			{/if}
		</div>
	{/if}

	<div class="mt-4 flex flex-wrap items-center gap-4">
		<!-- A plain div, not a wrapping label: wrapping the select made its
		     accessible name concatenate every option ("Expires after 1 hour1
		     day7 days if unread"). flex-wrap because at 200% zoom on a 320px
		     screen "if unread" was pushed 130px offscreen inside an
		     overflow-hidden main — unreachable, and it is the qualifier that
		     makes the sentence true. -->
		<div class="flex flex-wrap items-center gap-2 text-sm text-mist">
			<label for="ttl">Expires after</label>
			<Select
				id="ttl"
				aria-describedby="ttl-note"
				options={ttlOptions}
				bind:value={ttl}
				disabled={busy}
			/>
			<span id="ttl-note">if unread</span>
		</div>

		<Checkbox bind:checked={usePassphrase} disabled={busy}>Add a passphrase</Checkbox>
	</div>

	{#if usePassphrase}
		<div in:fade={{ duration: dur(200) }} class="mt-3">
			<TextInput
				type="password"
				bind:value={passphrase}
				disabled={busy}
				aria-label="Passphrase"
				placeholder="Passphrase (needed to open, on top of the link)"
			/>
			<p class="mt-1.5 text-xs text-ghost">
				Two-factor: the reader needs both the link and this passphrase. Share the passphrase
				separately.
			</p>
		</div>
	{/if}

	{#if error}
		<div in:fade={{ duration: dur(200) }}>
			<Alert class="mt-3">
				{error}
				<!-- Being told a thing needs Pro, with no way to get Pro, is a dead
				     end. The link goes to the pay point, where the price and what
				     Stripe sees are stated before any button exists to press. -->
				{#if needsPro}
					<a class="underline underline-offset-2" href="/pro">See what Pro costs</a>.
				{/if}
			</Alert>
		</div>
	{/if}

	{#if busy}
		<div in:fade={{ duration: dur(150) }} class="mt-5">
			<PhaseProgress
				label={phaseLabel[phase]}
				value={phase === 'uploading' ? uploaded : undefined}
			>
				{#snippet cancel()}
					{#if phase === 'uploading'}
						<QuietLink class="mt-3 text-xs" onclick={oncancel}>Cancel</QuietLink>
					{/if}
				{/snippet}
			</PhaseProgress>
		</div>
	{:else}
		<Button variant="ember" onclick={oncreate} disabled={!ready} class="mt-5 w-full py-3 text-sm">
			Create one-time link
		</Button>
	{/if}
	{/if}
</Card>
