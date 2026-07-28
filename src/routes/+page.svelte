<script lang="ts">
	// THE SENDING ROUTE. It owns exactly one thing the UI layer must never own:
	// the orchestration between this browser's crypto and the server that will
	// hold the ciphertext. Every pixel below it belongs to a component.
	import { onMount } from 'svelte';
	import { fly } from 'svelte/transition';
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
	import { PRO_PRICE, PRO_CREDITS } from '$lib/pro';
	import Merkaba from '$lib/ui/atoms/Merkaba.svelte';
	import Wordmark from '$lib/ui/atoms/Wordmark.svelte';
	import VaultPage from '$lib/ui/templates/VaultPage.svelte';
	import SendComposer, { type Phase } from '$lib/ui/organisms/SendComposer.svelte';
	import LinkReadyPanel from '$lib/ui/organisms/LinkReadyPanel.svelte';
	import SiteFooter from '$lib/ui/organisms/SiteFooter.svelte';
	import { humanSize } from '$lib/ui/format';

	let mode = $state('note');
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

	// A Svelte transition is a WAAPI animation, which no CSS rule can stop —
	// `prefers-reduced-motion` has to be honored here, at its source.
	const dur = (ms: number) => (prefersReducedMotion.current ? 0 : ms);

	const busy = $derived(phase !== 'idle');
	const ready = $derived(mode === 'note' ? text.trim().length > 0 : file !== null);

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
	<link rel="canonical" href="https://cinder.ink/" />
	<meta
		name="description"
		content="Write a note or choose a file. Cinder encrypts it in your browser and hands you one link. One successful reveal removes Cinder's stored copy. Copies outside Cinder remain outside its control."
	/>
</svelte:head>

<VaultPage>
	{#snippet header()}
		<!-- The merkaba as a crest: two counter-rotating tetrahedra = two-factor, made visible. -->
		<div class="relative mx-auto mb-5 h-24 w-24">
			<Merkaba size={96} />
		</div>
		<Wordmark as="heading" />
		<p class="mt-2 text-sm text-mist">
			One retrieval from Cinder. Encrypted in your browser — we never see it.
		</p>
	{/snippet}

	{#if link}
		<div in:fly={{ y: 12, duration: dur(350) }}>
			<LinkReadyPanel {link} onreset={reset} />
		</div>
	{:else}
		<SendComposer
			bind:mode
			bind:text
			bind:passphrase
			bind:usePassphrase
			bind:ttl
			{file}
			{parts}
			{credits}
			{busy}
			{phase}
			{uploaded}
			{ready}
			{error}
			{needsPro}
			{dur}
			onpick={pickFile}
			oncreate={create}
			oncancel={cancel}
		/>
	{/if}

	<SiteFooter {credits} />
</VaultPage>
