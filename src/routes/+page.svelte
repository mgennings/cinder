<script lang="ts">
	import { onMount } from 'svelte';
	import { fade, fly } from 'svelte/transition';
	import { prefersReducedMotion } from 'svelte/motion';
	import { encryptNote } from '$lib/crypto/note-crypto';
	import {
		encryptFile,
		encryptFileParts,
		partCountFor,
		MAX_FILE_BYTES,
		MAX_TRANSFER_BYTES,
		FileTooLargeError,
		FilenameTooLongError,
		TransferTooLargeError
	} from '$lib/crypto/file-crypto';
	import {
		createNote,
		createFileTransfer,
		createMultipartTransfer,
		uploadCiphertext,
		finalizeFileTransfer,
		TransferNotEntitledError
	} from '$lib/api';
	import { buildLink, buildFileLink, buildTransferLink, derivePartLocator } from '$lib/link';
	import { capabilityGrant, CAPABILITY_MULTIPART_TRANSFER } from '$lib/entitlement';
	import { entitlement, signedIn, identityConfigured } from '$lib/auth';
	import { PRO_PRICE, PRO_CREDITS, creditWord } from '$lib/pro';
	import CopyLink from '$lib/ui/CopyLink.svelte';
	import Merkaba from '$lib/ui/Merkaba.svelte';
	import { terrain } from '$lib/ui/terrain';

	type Mode = 'note' | 'file';
	// The sender's journey, named by what is actually happening. Every one of
	// these is a state a person can be looking at, so each gets real words.
	type Phase = 'idle' | 'encrypting' | 'uploading' | 'finalizing';

	let mode: Mode = $state('note');
	let text = $state('');
	let file: File | null = $state(null);
	let passphrase = $state('');
	let usePassphrase = $state(false);
	let ttl = $state('86400'); // default 1 day
	let phase: Phase = $state('idle');
	let uploaded = $state(0); // 0..1, real bytes on the wire
	let error = $state('');
	// Whether the current error is the one the pay point can resolve. A separate
	// flag rather than matching on the message text, because copy changes and a
	// string comparison would silently stop offering the link.
	let needsPro = $state(false);
	let link = $state('');

	// The balance, if this browser is signed in and this build has accounts at
	// all. null means "we have no idea" — signed out, or a build with no identity
	// API — and it must not be shown as zero: telling someone they have none when
	// we never asked is worse than saying nothing.
	let credits = $state<number | null>(null);

	const readCredits = async () => {
		credits = identityConfigured() && signedIn() ? (await entitlement()).credits : null;
	};
	onMount(readCredits);

	let aborter: AbortController | null = null;

	// After the link appears, focus has to land on it — otherwise a keyboard
	// user is silently returned to the top of the document at the exact moment
	// the thing they came for is on screen.
	let readyHeading: HTMLElement | null = $state(null);
	$effect(() => {
		if (link) readyHeading?.focus();
	});

	// A Svelte transition is a WAAPI animation, which no CSS rule can stop —
	// `prefers-reduced-motion` has to be honored here, at its source.
	const dur = (ms: number) => (prefersReducedMotion.current ? 0 : ms);

	const busy = $derived(phase !== 'idle');
	const ready = $derived(mode === 'note' ? text.trim().length > 0 : file !== null);

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

	// Deliberately decimal MB, matching what a phone's file browser shows the
	// person. Agreeing with their operating system beats being pedantic.
	function humanSize(bytes: number): string {
		if (bytes < 1000) return `${bytes} bytes`;
		if (bytes < 1000 * 1000) return `${(bytes / 1000).toFixed(0)} KB`;
		return `${(bytes / (1000 * 1000)).toFixed(1)} MB`;
	}

	const maxLabel = `${Math.round(MAX_FILE_BYTES / (1024 * 1024))} MiB`;
	const maxProLabel = `${Math.round(MAX_TRANSFER_BYTES / (1024 * 1024))} MiB`;

	// Over the free ceiling, the file is sent in pieces. The count is shown before
	// anything happens, because it is also what the recipient will be asked to
	// accept — a piece that fails destroys the whole transfer, and the sender
	// should know that when choosing the file, not when reading a support email.
	const parts = $derived.by(() => {
		const chosen: File | null = file;
		return chosen ? partCountFor(chosen.size) : 1;
	});

	function pickFile(e: Event) {
		const input = e.currentTarget as HTMLInputElement;
		const chosen = input.files?.[0] ?? null;
		error = '';
		needsPro = false;
		if (chosen && chosen.size > MAX_TRANSFER_BYTES) {
			error = `That file is ${humanSize(chosen.size)}. The limit is ${maxProLabel}.`;
			file = null;
			input.value = '';
			return;
		}
		file = chosen;
	}

	function cancel() {
		// Only meaningful before finalize: nothing is retrievable until the
		// server has verified the stored object, so abandoning here leaves an
		// orphan that lifecycle cleanup collects.
		aborter?.abort();
		aborter = null;
		phase = 'idle';
		uploaded = 0;
	}

	async function create() {
		if (!ready || busy) return;
		// A checked-but-empty passphrase would silently create an unprotected
		// note — make the user's intent real instead of dropping it on the floor.
		if (usePassphrase && !passphrase.trim()) {
			error = 'Enter a passphrase, or uncheck the box.';
			return;
		}
		error = '';
		needsPro = false;
		const pass = usePassphrase && passphrase ? passphrase : undefined;

		try {
			if (mode === 'note') {
				phase = 'encrypting';
				const { payload, fragmentKey } = await encryptNote(text, pass);
				const id = await createNote(payload, Number(ttl));
				link = buildLink(location.origin, id, fragmentKey);
			} else if (file && parts > 1) {
				link = await createChunked(file, pass);
				// The mint spent a credit somewhere inside that call, so the number on
				// screen is now stale. Re-read it rather than decrementing locally: a
				// retried send reuses one cached grant and costs nothing, and guessing
				// which of those just happened is how a balance starts lying.
				await readCredits();
			} else if (file) {
				phase = 'encrypting';
				const envelope = await encryptFile(file, pass);

				const grant = await createFileTransfer(
					envelope.ciphertextBytes,
					envelope.ciphertextSha256,
					Number(ttl)
				);

				phase = 'uploading';
				uploaded = 0;
				aborter = new AbortController();
				await uploadCiphertext(grant.upload, envelope.ciphertext, {
					onProgress: (f) => (uploaded = f),
					signal: aborter.signal
				});

				phase = 'finalizing';
				await finalizeFileTransfer(grant.locator, grant.uploadCapability);
				link = buildFileLink(location.origin, grant.locator, envelope.fragmentKey);
			}
		} catch (e) {
			if (e instanceof DOMException && e.name === 'AbortError') return; // cancel() already reset
			if (e instanceof TransferNotEntitledError) {
				error =
					credits === 0
						? `That send needs one credit and this account has none left. ${PRO_PRICE} adds ${PRO_CREDITS} more. Anything under ${maxLabel} still sends free.`
						: `Sending more than ${maxLabel} costs up to one Cinder Pro credit, which covers about fifteen minutes of large sends. Everything else about the transfer is identical — Pro adds size, it does not change the promise.`;
				needsPro = true;
			} else if (e instanceof TransferTooLargeError) error = `That file is over the ${maxProLabel} limit.`;
			else if (e instanceof FileTooLargeError) error = `That file is over the ${maxLabel} limit.`;
			else if (e instanceof FilenameTooLongError) error = 'That filename is too long.';
			else error = e instanceof Error ? e.message : 'Something went wrong.';
		} finally {
			aborter = null;
			if (!link) uploaded = 0;
			phase = 'idle';
		}
	}

	// A file over the free ceiling. Every step below is the single-file step run N
	// times against N independent grants — there is no bulk upload, no bulk
	// finalize, and no bulk claim. That is the point: the guarantee at 200 MB is
	// the same code as the guarantee at 3 MB, not a larger version of it.
	async function createChunked(f: File, pass?: string): Promise<string> {
		phase = 'encrypting';
		const envelope = await encryptFileParts(f, pass);

		const grant = await createMultipartTransfer(
			envelope.parts.map((p) => ({
				ciphertextBytes: p.ciphertextBytes,
				ciphertextSha256: p.ciphertextSha256
			})),
			Number(ttl),
			await capabilityGrant(CAPABILITY_MULTIPART_TRANSFER)
		);

		phase = 'uploading';
		uploaded = 0;
		aborter = new AbortController();

		// Progress is weighted by real bytes rather than by part number, so a
		// 40 MiB transfer does not sit at "1 of 10" for a tenth of the upload and
		// then jump.
		const totalBytes = envelope.parts.reduce((n, p) => n + p.ciphertextBytes, 0);
		let sent = 0;
		for (const { index, upload } of grant.parts) {
			const part = envelope.parts[index];
			await uploadCiphertext(upload, part.ciphertext, {
				onProgress: (fraction) => (uploaded = (sent + fraction * part.ciphertextBytes) / totalBytes),
				signal: aborter.signal
			});
			sent += part.ciphertextBytes;
			uploaded = sent / totalBytes;
		}

		// One finalize per part, each of which makes the server look at that
		// object in S3 and decide for itself. A part that does not verify leaves
		// the whole transfer unclaimable, which is the correct failure: an
		// incomplete file must never become deliverable.
		phase = 'finalizing';
		for (const { index } of grant.parts) {
			await finalizeFileTransfer(
				await derivePartLocator(grant.locator, index),
				grant.uploadCapability
			);
		}

		return buildTransferLink(
			location.origin,
			grant.locator,
			envelope.fragmentKey,
			envelope.parts.length
		);
	}

	function reset() {
		text = '';
		file = null;
		passphrase = '';
		usePassphrase = false;
		link = '';
		error = '';
		uploaded = 0;
	}
</script>

<svelte:head>
	<title>Cinder — an encrypted note or file retrieved once</title>
	<meta
		name="description"
		content="Write a note or choose a file. Cinder encrypts it in your browser and hands you one link. One successful reveal removes Cinder's stored copy. Copies outside Cinder remain outside its control."
	/>
</svelte:head>

<main
	{@attach terrain()}
	class="vault-glow relative flex min-h-screen flex-col items-center justify-center overflow-hidden px-5 py-16"
>
	<div class="relative w-full max-w-lg">
		<header class="mb-8 text-center">
			<!-- The merkaba as a crest: two counter-rotating tetrahedra = two-factor, made visible. -->
			<div class="relative mx-auto mb-5 h-24 w-24">
				<Merkaba size={96} />
			</div>
			<h1 class="text-3xl font-bold tracking-tight">
				Cinder<span class="text-ember">.</span>
			</h1>
			<p class="mt-2 text-sm text-mist">
				One retrieval from Cinder. Encrypted in your browser — we never see it.
			</p>
		</header>

		{#if link}
			<section in:fly={{ y: 12, duration: dur(350) }} class="card p-6">
				<h2
					bind:this={readyHeading}
					tabindex="-1"
					class="mb-1 text-sm font-semibold text-ember-ink outline-none"
				>
					Your one-time link is ready
				</h2>
				<p class="mb-4 text-xs text-ghost">Opening is safe. Reveal removes Cinder's stored copy.</p>
				<CopyLink {link} />
				<button onclick={reset} class="link-quiet mt-5 text-xs">Send something else</button>
			</section>
		{:else}
			<section class="card p-6">
				<fieldset>
					<legend class="sr-only">What are you sending?</legend>
					<div class="seg">
						<label class="seg-option">
							<input type="radio" name="mode" value="note" bind:group={mode} disabled={busy} />
							Note
						</label>
						<label class="seg-option">
							<input type="radio" name="mode" value="file" bind:group={mode} disabled={busy} />
							File
						</label>
					</div>
				</fieldset>

				{#if mode === 'note'}
					<div class="mt-4">
						<textarea
							bind:value={text}
							aria-label="Your secret note"
							placeholder="Type your secret. It never leaves this device unencrypted."
							rows="6"
							class="field resize-none px-4 py-3 text-base leading-relaxed"
						></textarea>
					</div>
				{:else}
					<div class="mt-4">
						<label for="file-input" class="mb-2 block text-sm text-mist">
							Choose one file, up to {maxLabel} — or up to {maxProLabel} with Pro
						</label>
						<input
							id="file-input"
							type="file"
							onchange={pickFile}
							disabled={busy}
							class="field cursor-pointer px-4 py-3 text-sm file:mr-3 file:cursor-pointer file:rounded-md file:border-0 file:bg-ink-raised file:px-3 file:py-1.5 file:text-sm file:font-semibold file:text-body"
						/>
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
						<select
							id="ttl"
							aria-describedby="ttl-note"
							bind:value={ttl}
							disabled={busy}
							class="field w-auto px-2 py-1.5 text-sm"
						>
							{#each ttlOptions as opt (opt.value)}
								<option value={opt.value}>{opt.label}</option>
							{/each}
						</select>
						<span id="ttl-note">if unread</span>
					</div>

					<!-- min-h-11 on the LABEL: the checkbox itself is 20px, but the
					     label is the real hit area and it measured 20px tall. -->
					<label class="flex min-h-11 cursor-pointer items-center gap-2 text-sm text-mist">
						<input type="checkbox" bind:checked={usePassphrase} disabled={busy} class="accent-ember" />
						Add a passphrase
					</label>
				</div>

				{#if usePassphrase}
					<div in:fade={{ duration: dur(200) }} class="mt-3">
						<input
							type="password"
							bind:value={passphrase}
							disabled={busy}
							aria-label="Passphrase" placeholder="Passphrase (needed to open, on top of the link)"
							class="field px-4 py-2.5 text-sm"
						/>
						<p class="mt-1.5 text-xs text-ghost">
							Two-factor: the reader needs both the link and this passphrase. Share the passphrase
							separately.
						</p>
					</div>
				{/if}

				{#if error}
					<p in:fade={{ duration: dur(200) }} role="alert" class="mt-3 text-sm text-ember-ink">
						{error}
						<!-- Being told a thing needs Pro, with no way to get Pro, is a dead
						     end. The link goes to the pay point, where the price and what
						     Stripe sees are stated before any button exists to press. -->
						{#if needsPro}
							<a class="underline underline-offset-2" href="/pro">See what Pro costs</a>.
						{/if}
					</p>
				{/if}

				{#if busy}
					<div in:fade={{ duration: dur(150) }} class="mt-5">
						<!-- One live region for the whole sequence, so a screen reader hears
						     each phase once instead of a stream of percentage changes. -->
						<p aria-live="polite" class="mb-2 text-xs text-mist">{phaseLabel[phase]}</p>
						{#if phase === 'uploading'}
							<progress class="progress" aria-label={phaseLabel[phase]} max="1" value={uploaded}
							></progress>
						{:else}
							<!-- A separate element, not `value={undefined}`: that sets the
							     property, which coerces to 0 and reads as "0 percent"
							     under a label that says "verifying". -->
							<progress class="progress" aria-label={phaseLabel[phase]}></progress>
						{/if}
						{#if phase === 'uploading'}
							<button onclick={cancel} class="link-quiet mt-3 text-xs">Cancel</button>
						{/if}
					</div>
				{:else}
					<button onclick={create} disabled={!ready} class="btn btn-ember mt-5 w-full py-3 text-sm">
						Create one-time link
					</button>
				{/if}
			</section>
		{/if}

		<footer class="mt-8 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-center text-xs">
			<a href="/security" class="link-quiet">How private is this, really?</a>
			<a href="/field-notes" class="link-quiet">Field notes</a>
			<!--
				The only way in to an account, and deliberately the quietest thing on
				the page. Sending needs no account and never will, so this must not
				read as a signup prompt on a product whose whole argument is that it
				does not know who you are. But someone who HAS paid needs a way back
				to their balance, and until this existed there was none: /account was
				reachable only from one sentence inside /security.
			-->
			{#if identityConfigured()}
				<a href={signedIn() ? '/account' : '/pro'} class="link-quiet">
					{#if credits !== null}
						{creditWord(credits)}
					{:else if signedIn()}
						Your account
					{:else}
						Cinder Pro
					{/if}
				</a>
			{/if}
		</footer>
	</div>
</main>
