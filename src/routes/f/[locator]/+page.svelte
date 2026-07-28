<script lang="ts">
	// THE RECEIVING ROUTE. It owns the delivery: what is claimed, in what order,
	// what is destroyed on the way, and what each failure honestly means. None of
	// that is renderable, and none of the rendering is decidable from here — so
	// every surface below belongs to a component and every claim belongs here.
	import { page } from '$app/state';
	import { onMount } from 'svelte';
	import { fade } from 'svelte/transition';
	import { prefersReducedMotion } from 'svelte/motion';
	import {
		checkTransferStatus,
		claimFile,
		TransferGoneError,
		DeliveryFailedError,
		TransferBusyError
	} from '$lib/api';
	import {
		decryptFile,
		decryptPart,
		partNeedsPassphrase,
		type DecryptedFile
	} from '$lib/crypto/file-crypto';
	import { parseFragmentKey, parseFragmentParts, derivePartLocator } from '$lib/link';
	import { transferStatusToken } from '$lib/status-store';
	import { humanSize } from '$lib/ui/format';
	import Card from '$lib/ui/atoms/Card.svelte';
	import Button from '$lib/ui/atoms/Button.svelte';
	import PulseDot from '$lib/ui/atoms/PulseDot.svelte';
	import LiveRegion from '$lib/ui/atoms/LiveRegion.svelte';
	import Wordmark from '$lib/ui/atoms/Wordmark.svelte';
	import VaultPage from '$lib/ui/templates/VaultPage.svelte';
	import RevealGate from '$lib/ui/organisms/RevealGate.svelte';
	import TransferRecord from '$lib/ui/organisms/TransferRecord.svelte';
	import OutcomePanel from '$lib/ui/organisms/OutcomePanel.svelte';

	type View = 'gate' | 'delivered' | 'gone' | 'lost' | 'busy' | 'error';

	const locator = $derived(page.params.locator ?? '');
	// The fragment (key) is read from the browser only — it never reached the server.
	let fragmentKey = $state('');
	// How many pieces this transfer is, according to the link. A hint until part
	// zero's authenticated header confirms it — but it has to be known BEFORE the
	// button is pressed, because the cost of pressing it depends on it.
	let partCount = $state(1);
	const chunked = $derived(partCount > 1);

	// How many pieces Cinder has already destroyed on our behalf. The moment this
	// is above zero the transfer cannot be abandoned safely, and every message on
	// the page has to stop talking about trying again.
	let consumed = $state(0);
	let view: View = $state('gate');
	let busy = $state(false);
	let status = $state('');
	let passphrase = $state('');
	let needsPassphrase = $state(false);
	let errorMsg = $state('');
	let saved: DecryptedFile | null = $state(null);
	let senderCheck: 'none' | 'checking' | 'available' | 'error' = $state('none');

	// One announcement region for the whole page, deliberately OUTSIDE the view
	// branches. An earlier version put it inside the gate, so it unmounted at the
	// exact moment there was something worth saying and every outcome — delivered,
	// gone, permanently lost — reached a screen reader as silence.
	let announcement = $state('');

	// Ciphertext we are holding after a successful claim while we wait for a
	// passphrase. There is no second copy anywhere: if this page reloads, it is
	// gone. That is why the warning below changes once this is set.
	let claimed: Uint8Array | null = $state(null);

	// Focus has to land somewhere deliberate after the view changes, or a
	// keyboard user is silently returned to the top of the document right after
	// the most consequential action on the site.
	let headingEl: HTMLElement | null = $state(null);
	let passphraseEl: HTMLInputElement | null = $state(null);

	// Motion tokens. `prefers-reduced-motion` is honored in CSS for the ambient
	// animations, but a Svelte transition is a WAAPI animation that no CSS rule
	// can reach — it has to be turned off here, at its source.
	const dur = (ms: number) => (prefersReducedMotion.current ? 0 : ms);

	$effect(() => {
		fragmentKey = parseFragmentKey(page.url.hash);
		partCount = parseFragmentParts(page.url.hash);
	});

	onMount(async () => {
		const token = transferStatusToken(locator);
		if (!token) return;
		senderCheck = 'checking';
		try {
			if ((await checkTransferStatus(token)) === 'gone') {
				view = 'gone';
				announcement = 'This transfer is gone. Cinder has no stored copy to return.';
				return;
			}
			senderCheck = 'available';
		} catch {
			// Advisory only. A failed glance never disables the actual claim.
			senderCheck = 'error';
		}
	});

	$effect(() => {
		if (view !== 'gate') headingEl?.focus();
	});

	// An inert download: a Blob the browser saves. Never a preview, never a
	// server round trip, never anything that executes what was sent.
	function save(f: DecryptedFile) {
		const url = URL.createObjectURL(
			new Blob([f.bytes as BlobPart], { type: f.type || 'application/octet-stream' })
		);
		const a = document.createElement('a');
		a.href = url;
		a.download = f.name;
		a.rel = 'noopener';
		a.click();
		URL.revokeObjectURL(url);
	}

	// A throttled or shed request never reached the Lambda, so the atomic claim
	// never ran and that part is untouched. On a single file the person can just
	// press the button again; across 64 parts, one shed request mid-transfer would
	// destroy the whole file over something that was never a failure at all. So a
	// busy part is retried here, with backoff, a bounded number of times.
	//
	// This is not a retry of a claim. A claim that HAPPENED is never retried and
	// never can be — that is what the guarantee costs. This retries a request that
	// provably did not happen, which is the one thing the guarantee leaves room
	// for, and TransferBusyError is exactly the error that says so.
	const BUSY_ATTEMPTS = 4;
	const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

	async function claimPart(partLocator: string): Promise<Uint8Array> {
		for (let attempt = 0; ; attempt++) {
			try {
				return await claimFile(partLocator);
			} catch (e) {
				if (!(e instanceof TransferBusyError) || attempt >= BUSY_ATTEMPTS - 1) throw e;
				await sleep(400 * 2 ** attempt);
			}
		}
	}

	// The chunked delivery. Parts are claimed strictly in order and strictly one
	// at a time, and the ordering is the honest one rather than the fast one:
	//
	//   - Part zero first, alone. If it needs a passphrase, we find out having
	//     destroyed exactly one part instead of all of them, and a wrong
	//     passphrase costs the smallest loss the design can offer.
	//   - Nothing is claimed after a failure. There is no partial file to save —
	//     the parts already delivered are useless without the ones that follow —
	//     so continuing would destroy more of something already unrecoverable.
	//
	// There is no resume, and there cannot be. Resuming would require a second
	// delivery attempt for a part Cinder has already deleted.
	async function revealChunked(): Promise<DecryptedFile> {
		const pieces: Uint8Array[] = [];
		let name = 'file';
		let type = '';

		for (let index = 0; index < partCount; index++) {
			// Part zero may already be in hand: the passphrase prompt claimed it,
			// then stopped. Claiming it a second time would answer 410, because the
			// first claim was the only one there was ever going to be.
			let sealed: Uint8Array;
			if (index === 0 && held) {
				sealed = held;
			} else {
				status = `Claiming piece ${index + 1} of ${partCount}…`;
				const partLocator = await derivePartLocator(locator, index);
				sealed = await claimPart(partLocator);
				consumed = index + 1;
			}

			// The passphrase question is answered by part zero's own bytes, and it
			// is answered before any other part is touched.
			if (index === 0 && partNeedsPassphrase(sealed) && !passphrase) {
				held = sealed;
				needsPassphrase = true;
				status = '';
				busy = false;
				announcement = `Cinder has already destroyed the first of ${partCount} pieces. This file needs its passphrase before the rest can be claimed. Do not reload this page.`;
				await Promise.resolve();
				passphraseEl?.focus();
				throw new PassphrasePause();
			}

			status = `Decrypting piece ${index + 1} of ${partCount}…`;
			const out = await decryptPart(sealed, fragmentKey, index, partCount, passphrase || undefined);
			if (index === 0) {
				held = null;
				// The link said how many pieces there are; part zero's authenticated
				// header says how many there really are. A mismatch means the link was
				// edited or truncated, and continuing would deliver a silently
				// incomplete file. Refuse instead.
				if (out.meta && out.meta.parts !== partCount) {
					throw new Error('This link does not match the file it points at.');
				}
				name = out.meta?.name ?? name;
				type = out.meta?.type ?? type;
			}
			pieces.push(out.bytes);
		}

		// Assembled only at the end, because there is no such thing as a usable
		// prefix of an encrypted file.
		const total = pieces.reduce((n, p) => n + p.length, 0);
		const bytes = new Uint8Array(total);
		let at = 0;
		for (const p of pieces) {
			bytes.set(p, at);
			at += p.length;
		}
		return { bytes, name, type };
	}

	// Not an error: the flow stopping to ask for a passphrase, which the catch
	// below has to let through untouched rather than render as a failure.
	class PassphrasePause extends Error {}

	// Part zero's ciphertext, held across the passphrase prompt. Same rule as
	// `claimed`: there is no second copy anywhere.
	let held: Uint8Array | null = $state(null);

	async function reveal() {
		if (busy) return;
		if (!fragmentKey) {
			errorMsg = 'This link is missing its key — it may have been copied incompletely.';
			view = 'error';
			return;
		}
		busy = true;
		errorMsg = '';

		try {
			if (chunked) {
				const out = await revealChunked();
				saved = out;
				save(out);
				view = 'delivered';
				announcement = `Delivered. ${out.name}, ${humanSize(out.bytes.length)}, reassembled from ${partCount} pieces and saved to your device. Every stored piece is deleted.`;
				return;
			}

			// The point of no return. After this resolves, Cinder's stored copy is
			// already deleted and its absence already verified — holding these
			// bytes is what proves it.
			if (!claimed) {
				// Not mirrored into `announcement`: the button holds focus and its own
				// accessible name becomes this string, so echoing it would say it twice.
				// The live region owns outcomes, which the button cannot say once it goes.
				status = 'Claiming the one delivery…';
				claimed = await claimFile(locator);
			}

			// Whether a passphrase is required is written in the envelope itself,
			// so this costs no request.
			if (claimed[1] !== 0 && !passphrase) {
				needsPassphrase = true;
				status = '';
				busy = false;
				// Say it, and put the cursor in it. Until this was added, the
				// delivery had already consumed the transfer and the person was
				// left in silence with no indication anything had happened.
				announcement =
					"Cinder's stored copy is already deleted. This file needs its passphrase to open. Do not reload this page.";
				await Promise.resolve();
				passphraseEl?.focus();
				return;
			}

			status = 'Decrypting on this device…';
			const out = await decryptFile(claimed, fragmentKey, passphrase || undefined);
			saved = out;
			save(out);
			view = 'delivered';
			announcement = `Delivered. ${out.name}, ${humanSize(out.bytes.length)}, saved to your device. Cinder's stored copy is deleted.`;
		} catch (e) {
			if (e instanceof PassphrasePause) {
				// Not a failure. The flow is waiting on the person, and `finally`
				// must not clear the state that put the prompt on screen.
				return;
			} else if (needsPassphrase && held) {
				// A wrong passphrase, checked BEFORE ordering more pieces destroyed.
				// Exactly one piece is spent and it is still in this tab, so the
				// person genuinely can try again — as long as they do not reload.
				errorMsg = `That passphrase didn't work. Cinder has already destroyed 1 of ${partCount} pieces, so try again carefully without reloading this page.`;
				announcement = errorMsg;
			} else if (chunked && consumed > 0) {
				// The decisive case, and the one this whole design had to answer
				// honestly. Some pieces are already destroyed and the rest cannot
				// stand in for them. There is nothing to retry, nothing to resume,
				// and no partial file worth handing over.
				view = 'lost';
				announcement = `The delivery stopped after ${consumed} of ${partCount} pieces. Those pieces are permanently destroyed, the file cannot be assembled, and this cannot be retried.`;
			} else if (e instanceof TransferGoneError) {
				view = 'gone';
				announcement = 'This transfer is gone. Cinder has no stored copy to return.';
			} else if (e instanceof TransferBusyError) {
				// The one recoverable failure in the whole product. Nothing was
				// consumed, so this must never render as destruction.
				view = 'busy';
				announcement =
					'Cinder is busy and could not start the delivery. Nothing was used up. This link still works — try again in a moment.';
			} else if (e instanceof DeliveryFailedError) {
				view = 'lost';
				announcement =
					'The delivery began but could not finish. Cinder no longer has a stored copy, and this cannot be retried.';
			} else if (needsPassphrase) {
				errorMsg =
					"That passphrase didn't work. Cinder's copy is already gone, so try again carefully without reloading this page.";
				announcement = errorMsg;
			} else {
				errorMsg = "Couldn't decrypt — the link may be wrong or corrupted.";
				view = 'error';
				announcement = errorMsg;
			}
		} finally {
			status = '';
			busy = false;
		}
	}
</script>

<svelte:head>
	<title>A one-time file · Cinder</title>
	<!-- Reader pages are noindex: they're ephemeral and carry a key in the fragment. -->
	<meta name="robots" content="noindex, nofollow" />
</svelte:head>

<!-- Outside every branch, so it survives the view change that has something to
     announce. Atomic, so the whole sentence is read rather than a diff. -->
<LiveRegion message={announcement} atomic />

<VaultPage>
	{#snippet header()}
		<Wordmark class="btn btn-ghost border-0 bg-transparent px-2 py-1" />
	{/snippet}

	<Card as="section" class="p-6">
		{#if view === 'gate'}
			{#if senderCheck !== 'none'}
				<p class="mb-4 text-center text-xs text-ghost" role="status">
					{#if senderCheck === 'checking'}
						Checking whether your transfer is still available…
					{:else if senderCheck === 'available'}
						Available now. Cinder returns no identity or timestamp; checking again can reveal when
						availability changes.
					{:else}
						Status is unavailable. Reveal still works and has not been attempted.
					{/if}
				</p>
			{/if}
			<RevealGate
				{partCount}
				{needsPassphrase}
				bind:passphrase
				bind:passphraseElement={passphraseEl}
				{errorMsg}
				{busy}
				{status}
				{dur}
				onreveal={reveal}
			/>
		{:else if view === 'delivered' && saved}
			<div in:fade={{ duration: dur(400) }}>
				<h1
					bind:this={headingEl}
					tabindex="-1"
					class="mb-4 flex items-center gap-2 text-xs font-medium text-ember-ink outline-none"
				>
					<PulseDot />
					Delivered. Copy it somewhere safe before you leave.
				</h1>

				<TransferRecord name={saved.name} bytes={saved.bytes.length} {partCount} />

				<Button onclick={() => saved && save(saved)} class="mt-5 w-full py-2.5 text-sm">
					Save again
				</Button>
				<p class="mt-3 text-center text-xs text-ghost">
					Saving again uses the copy already in this tab. Closing it ends the transfer.
				</p>
			</div>
		{:else if view === 'gone'}
			<div in:fade={{ duration: dur(300) }}>
				<OutcomePanel title="This transfer is gone" bind:heading={headingEl}>
					Cinder has no stored copy to return. That is all it can tell you.
					{#snippet action()}
						<Button href="/" class="mt-6 px-5 py-2.5 text-sm">Send your own</Button>
					{/snippet}
				</OutcomePanel>
			</div>
		{:else if view === 'busy'}
			<div in:fade={{ duration: dur(300) }}>
				<OutcomePanel title="Cinder is busy right now" bind:heading={headingEl}>
					The delivery never started, so nothing was used up. This link still works. Wait a moment
					and try again — you have not lost anything.
					{#snippet action()}
						<Button
							variant="ember"
							class="mt-6 w-full py-3 text-sm"
							onclick={() => {
								view = 'gate';
								errorMsg = '';
							}}
						>
							Try again
						</Button>
					{/snippet}
				</OutcomePanel>
			</div>
		{:else if view === 'lost'}
			<div in:fade={{ duration: dur(300) }}>
				<OutcomePanel title="The delivery began but could not finish" bind:heading={headingEl}>
					{#if chunked}
						Cinder handed over {consumed} of {partCount} pieces and destroyed each one as it went.
						Those pieces are gone, and a file is not usable in pieces. This cannot be retried or
						resumed — that is the cost of deleting before delivering. Ask the sender for a new link.
					{:else}
						Cinder's stored copy was already deleted when the transfer started, so there is nothing
						left to send. This cannot be retried. Ask the sender for a new link.
					{/if}
					{#snippet action()}
						<Button href="/" class="mt-6 px-5 py-2.5 text-sm">Go to Cinder</Button>
					{/snippet}
				</OutcomePanel>
			</div>
		{:else}
			<div in:fade={{ duration: dur(300) }}>
				<OutcomePanel title="Couldn't open this file" bind:heading={headingEl}>
					{errorMsg}
					{#snippet action()}
						<Button href="/" class="mt-6 px-5 py-2.5 text-sm">Go to Cinder</Button>
					{/snippet}
				</OutcomePanel>
			</div>
		{/if}
	</Card>
</VaultPage>
