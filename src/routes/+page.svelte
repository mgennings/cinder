<script lang="ts">
	import { fade, fly } from 'svelte/transition';
	import { prefersReducedMotion } from 'svelte/motion';
	import { encryptNote } from '$lib/crypto/note-crypto';
	import {
		encryptFile,
		MAX_FILE_BYTES,
		FileTooLargeError,
		FilenameTooLongError
	} from '$lib/crypto/file-crypto';
	import {
		createNote,
		createFileTransfer,
		uploadCiphertext,
		finalizeFileTransfer
	} from '$lib/api';
	import { buildLink, buildFileLink } from '$lib/link';
	import CopyLink from '$lib/ui/CopyLink.svelte';
	import Merkaba from '$lib/ui/Merkaba.svelte';

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
	let link = $state('');

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

	function pickFile(e: Event) {
		const input = e.currentTarget as HTMLInputElement;
		const chosen = input.files?.[0] ?? null;
		error = '';
		if (chosen && chosen.size > MAX_FILE_BYTES) {
			error = `That file is ${humanSize(chosen.size)}. The limit is ${maxLabel}.`;
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
		const pass = usePassphrase && passphrase ? passphrase : undefined;

		try {
			if (mode === 'note') {
				phase = 'encrypting';
				const { payload, fragmentKey } = await encryptNote(text, pass);
				const id = await createNote(payload, Number(ttl));
				link = buildLink(location.origin, id, fragmentKey);
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
			if (e instanceof FileTooLargeError) error = `That file is over the ${maxLabel} limit.`;
			else if (e instanceof FilenameTooLongError) error = 'That filename is too long.';
			else error = e instanceof Error ? e.message : 'Something went wrong.';
		} finally {
			aborter = null;
			if (!link) uploaded = 0;
			phase = 'idle';
		}
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

<main class="vault-glow relative flex min-h-screen flex-col items-center justify-center overflow-hidden px-5 py-16">
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
							Choose one file, up to {maxLabel}
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
					<p in:fade={{ duration: dur(200) }} role="alert" class="mt-3 text-sm text-ember-ink">{error}</p>
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

		<footer class="mt-8 text-center text-xs">
			<a href="/security" class="link-quiet">How private is this, really?</a>
		</footer>
	</div>
</main>
