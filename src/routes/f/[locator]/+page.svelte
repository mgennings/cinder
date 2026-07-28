<script lang="ts">
	import { page } from '$app/state';
	import { fade } from 'svelte/transition';
	import { prefersReducedMotion } from 'svelte/motion';
	import { claimFile, TransferGoneError, DeliveryFailedError, TransferBusyError } from '$lib/api';
	import {
		decryptFile,
		decryptPart,
		partNeedsPassphrase,
		type DecryptedFile
	} from '$lib/crypto/file-crypto';
	import { parseFragmentKey, parseFragmentParts, derivePartLocator } from '$lib/link';
	import { terrain } from '$lib/ui/terrain';

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

	$effect(() => {
		if (view !== 'gate') headingEl?.focus();
	});

	function humanSize(bytes: number): string {
		if (bytes < 1000) return `${bytes} bytes`;
		if (bytes < 1000 * 1000) return `${(bytes / 1000).toFixed(0)} KB`;
		return `${(bytes / (1000 * 1000)).toFixed(1)} MB`;
	}

	// Truncating a filename from the right throws away the extension, which is
	// the part that tells you what you just received. Keep both ends.
	function middleTruncate(name: string, max = 34): string {
		if (name.length <= max) return name;
		const keepEnd = Math.min(12, Math.floor(max / 2));
		return `${name.slice(0, max - keepEnd - 1)}…${name.slice(-keepEnd)}`;
	}

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
<p aria-live="polite" aria-atomic="true" class="sr-only">{announcement}</p>

<main
	{@attach terrain()}
	class="vault-glow flex min-h-screen flex-col items-center justify-center px-5 py-16"
>
	<div class="w-full max-w-lg">
		<header class="mb-8 text-center">
			<a href="/" class="btn btn-ghost !min-h-0 border-0 bg-transparent px-2 py-1 text-2xl font-bold tracking-tight">
				Cinder<span class="text-ember">.</span>
			</a>
		</header>

		<section class="card p-6">
			{#if view === 'gate'}
				<div>
					<h1 class="text-center text-lg font-semibold">Someone left you a one-time file</h1>

					{#if needsPassphrase}
						<!-- The claim already happened. The pre-claim warning below is now
						     false — "can begin" describes something that has begun — so it
						     is replaced rather than left standing next to a passphrase box. -->
						<p in:fade={{ duration: dur(200) }} class="mt-3 text-sm leading-relaxed text-mist">
							{#if chunked}
								Cinder has already destroyed the first of {partCount} pieces. That piece is held only
								in this tab, and the rest will not be claimed until the passphrase opens it. If you
								reload or close this page, the file is permanently unavailable.
							{:else}
								Cinder's stored copy is already deleted. The encrypted file is held only in this tab,
								and it needs its passphrase to open. If you reload or close this page before it
								saves, it is permanently unavailable.
							{/if}
						</p>

						<div in:fade={{ duration: dur(200) }} class="mt-5">
							<label for="pass" class="mb-2 block text-sm text-mist">Passphrase</label>
							<input
								id="pass"
								bind:this={passphraseEl}
								type="password"
								autocomplete="off"
								bind:value={passphrase}
								onkeydown={(e) => e.key === 'Enter' && reveal()}
								placeholder="Enter the passphrase"
								class="field px-4 py-2.5 text-sm"
							/>
							{#if errorMsg}
								<p role="alert" class="mt-2 text-sm text-ember-ink">{errorMsg}</p>
							{/if}
						</div>
					{:else}
						<!-- The approved warning. Every clause here is enforced by the
						     backend; none of it is softened to make the button easier to
						     press. The chunked version says the extra cost out loud BEFORE
						     the button, because a file delivered in pieces can fail partway
						     and nobody should learn that halfway through. -->
						<p id="reveal-warning" class="mt-3 text-sm leading-relaxed text-mist">
							{#if chunked}
								This file arrives in {partCount} pieces. Cinder deletes each stored piece before it
								releases that piece's bytes, one at a time. If any piece fails, every piece already
								delivered is permanently destroyed and the file cannot be assembled — there is no
								retry and no resume. Keep this tab open until it saves. Copies saved by the sender,
								recipient, browser, operating system, or another service remain outside Cinder's
								control.
							{:else}
								Exactly one server delivery can begin. Cinder deletes its encrypted stored copy before
								releasing bytes. If that delivery fails, the file is permanently unavailable. Copies
								saved by the sender, recipient, browser, operating system, or another service remain
								outside Cinder's control.
							{/if}
						</p>
					{/if}

					<button
						id="reveal"
						onclick={reveal}
						disabled={busy}
						aria-describedby={needsPassphrase ? undefined : 'reveal-warning'}
						class="btn btn-ember mt-6 w-full py-3 text-sm"
					>
						{#if busy}
							<span class="pulse-dot inline-block h-2 w-2 rounded-full bg-black/70"></span>
							{status || 'Working…'}
						{:else if needsPassphrase}
							Unlock and save
						{:else if chunked}
							Reveal and destroy all {partCount} stored pieces
						{:else}
							Reveal and destroy Cinder's stored copy
						{/if}
					</button>
				</div>
			{:else if view === 'delivered' && saved}
				<div in:fade={{ duration: dur(400) }}>
					<h1
						bind:this={headingEl}
						tabindex="-1"
						class="mb-4 flex items-center gap-2 text-xs font-medium text-ember-ink outline-none"
					>
						<span class="pulse-dot inline-block h-2 w-2 rounded-full bg-ember"></span>
						Delivered. Copy it somewhere safe before you leave.
					</h1>

					<!-- Every row below is a fact. Four are entailed by the bytes this
					     page is holding — the server cannot return a body until the
					     delete and the absence check have both succeeded. The fifth is
					     entailed by the key never having left the fragment. -->
					<div class="record">
						<div class="record-row">
							<span class="record-label">File</span>
							<!-- Mono for the two rows that are measurements rather than
							     statements. A filename and a byte count are what the machine
							     read off the bytes in this tab; the rows below them are
							     claims about what the server did, and a claim set in mono
							     borrows an authority it should have to earn in words. -->
							<span class="record-value record-data break-all" title={saved.name}
								>{middleTruncate(saved.name)}</span
							>
						</div>
						<div class="record-row">
							<span class="record-label">Size</span>
							<span class="record-value record-data">{humanSize(saved.bytes.length)}</span>
						</div>
						{#if chunked}
							<div class="record-row">
								<span class="record-label">Pieces</span>
								<span class="record-value"><span class="record-mark"></span>{partCount} of {partCount} delivered</span>
							</div>
						{/if}
						<div class="record-row">
							<span class="record-label">Delivery</span>
							<span class="record-value"><span class="record-mark"></span>Consumed</span>
						</div>
						<div class="record-row">
							<span class="record-label">Stored {chunked ? 'pieces' : 'copy'}</span>
							<span class="record-value"><span class="record-mark"></span>Deleted, absence verified</span>
						</div>
						<div class="record-row">
							<span class="record-label">Decryption</span>
							<span class="record-value"><span class="record-mark"></span>This device only</span>
						</div>
					</div>

					<button onclick={() => saved && save(saved)} class="btn btn-ghost mt-5 w-full py-2.5 text-sm">
						Save again
					</button>
					<p class="mt-3 text-center text-xs text-ghost">
						Saving again uses the copy already in this tab. Closing it ends the transfer.
					</p>
				</div>
			{:else if view === 'gone'}
				<div in:fade={{ duration: dur(300) }} class="text-center">
					<h1 bind:this={headingEl} tabindex="-1" class="text-lg font-semibold outline-none">
						This transfer is gone
					</h1>
					<p class="mt-2 text-sm text-mist">
						Cinder has no stored copy to return. That is all it can tell you.
					</p>
					<a href="/" class="btn btn-ghost mt-6 px-5 py-2.5 text-sm">Send your own</a>
				</div>
			{:else if view === 'busy'}
				<div in:fade={{ duration: dur(300) }} class="text-center">
					<h1 bind:this={headingEl} tabindex="-1" class="text-lg font-semibold outline-none">
						Cinder is busy right now
					</h1>
					<p class="mt-2 text-sm text-mist">
						The delivery never started, so nothing was used up. This link still works. Wait a moment
						and try again — you have not lost anything.
					</p>
					<button
						onclick={() => {
							view = 'gate';
							errorMsg = '';
						}}
						class="btn btn-ember mt-6 w-full py-3 text-sm"
					>
						Try again
					</button>
				</div>
			{:else if view === 'lost'}
				<div in:fade={{ duration: dur(300) }} class="text-center">
					<h1 bind:this={headingEl} tabindex="-1" class="text-lg font-semibold outline-none">
						The delivery began but could not finish
					</h1>
					{#if chunked}
						<p class="mt-2 text-sm text-mist">
							Cinder handed over {consumed} of {partCount} pieces and destroyed each one as it went.
							Those pieces are gone, and a file is not usable in pieces. This cannot be retried or
							resumed — that is the cost of deleting before delivering. Ask the sender for a new link.
						</p>
					{:else}
						<p class="mt-2 text-sm text-mist">
							Cinder's stored copy was already deleted when the transfer started, so there is nothing
							left to send. This cannot be retried. Ask the sender for a new link.
						</p>
					{/if}
					<a href="/" class="btn btn-ghost mt-6 px-5 py-2.5 text-sm">Go to Cinder</a>
				</div>
			{:else}
				<div in:fade={{ duration: dur(300) }} class="text-center">
					<h1 bind:this={headingEl} tabindex="-1" class="text-lg font-semibold outline-none">
						Couldn't open this file
					</h1>
					<p class="mt-2 text-sm text-mist">{errorMsg}</p>
					<a href="/" class="btn btn-ghost mt-6 px-5 py-2.5 text-sm">Go to Cinder</a>
				</div>
			{/if}
		</section>
	</div>
</main>
