<script lang="ts">
	import { page } from '$app/state';
	import { fade } from 'svelte/transition';
	import { claimFile, TransferGoneError, DeliveryFailedError } from '$lib/api';
	import { decryptFile, type DecryptedFile } from '$lib/crypto/file-crypto';
	import { parseFragmentKey } from '$lib/link';

	type View = 'gate' | 'delivered' | 'gone' | 'lost' | 'error';

	const locator = $derived(page.params.locator ?? '');
	// The fragment (key) is read from the browser only — it never reached the server.
	let fragmentKey = $state('');
	let view: View = $state('gate');
	let busy = $state(false);
	let status = $state('');
	let passphrase = $state('');
	let needsPassphrase = $state(false);
	let errorMsg = $state('');
	let saved: DecryptedFile | null = $state(null);

	// Ciphertext we are holding after a successful claim while we wait for a
	// passphrase. There is no second copy anywhere: if this page reloads, it is
	// gone. That is why the warning below says what it says.
	let claimed: Uint8Array | null = $state(null);

	$effect(() => {
		fragmentKey = parseFragmentKey(page.url.hash);
	});

	function humanSize(bytes: number): string {
		if (bytes < 1000) return `${bytes} bytes`;
		if (bytes < 1000 * 1000) return `${(bytes / 1000).toFixed(0)} KB`;
		return `${(bytes / (1000 * 1000)).toFixed(1)} MB`;
	}

	// An inert download: a Blob the browser saves. Never a preview, never a
	// server round trip, never anything that executes what was sent.
	function save(f: DecryptedFile) {
		const url = URL.createObjectURL(new Blob([f.bytes as BlobPart], { type: f.type || 'application/octet-stream' }));
		const a = document.createElement('a');
		a.href = url;
		a.download = f.name;
		a.rel = 'noopener';
		a.click();
		URL.revokeObjectURL(url);
	}

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
			// The point of no return. After this resolves, Cinder's stored copy is
			// already deleted and its absence already verified — holding these
			// bytes is what proves it.
			if (!claimed) {
				status = 'Claiming the one delivery…';
				claimed = await claimFile(locator);
			}

			// Whether a passphrase is required is written in the envelope itself,
			// so this costs no request.
			if (claimed[1] !== 0 && !passphrase) {
				needsPassphrase = true;
				status = '';
				busy = false;
				return;
			}

			status = 'Decrypting on this device…';
			const out = await decryptFile(claimed, fragmentKey, passphrase || undefined);
			saved = out;
			save(out);
			view = 'delivered';
		} catch (e) {
			if (e instanceof TransferGoneError) {
				view = 'gone';
			} else if (e instanceof DeliveryFailedError) {
				view = 'lost';
			} else if (needsPassphrase) {
				errorMsg =
					"That passphrase didn't work. Cinder's copy is already gone, so try again carefully without reloading this page.";
			} else {
				errorMsg = "Couldn't decrypt — the link may be wrong or corrupted.";
				view = 'error';
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

<main class="vault-glow flex min-h-screen flex-col items-center justify-center px-5 py-16">
	<div class="w-full max-w-lg">
		<header class="mb-8 text-center">
			<a href="/" class="text-2xl font-bold tracking-tight">Cinder<span class="text-ember">.</span></a>
		</header>

		<section class="card p-6">
			{#if view === 'gate'}
				<div>
					<h1 class="text-center text-lg font-semibold">Someone left you a one-time file</h1>

					<!-- The approved warning. Every clause here is enforced by the
					     backend; none of it is softened to make the button easier to
					     press. -->
					<p class="mt-3 text-sm leading-relaxed text-mist">
						Exactly one server delivery can begin. Cinder deletes its encrypted stored copy before
						releasing bytes. If that delivery fails, the file is permanently unavailable. Copies
						saved by the sender, recipient, browser, operating system, or another service remain
						outside Cinder's control.
					</p>

					{#if needsPassphrase}
						<div in:fade={{ duration: 200 }} class="mt-5">
							<label for="pass" class="mb-2 block text-sm text-mist">
								This file needs its passphrase.
							</label>
							<input
								id="pass"
								type="password"
								bind:value={passphrase}
								onkeydown={(e) => e.key === 'Enter' && reveal()}
								placeholder="Enter the passphrase"
								class="field px-4 py-2.5 text-sm"
							/>
							{#if errorMsg}
								<p role="alert" class="mt-2 text-sm text-ember">{errorMsg}</p>
							{/if}
						</div>
					{/if}

					<p aria-live="polite" class="sr-only">{status}</p>

					<!-- Stable id: this button's visible label deliberately changes to the
					     live status while the claim runs, so nothing should identify it by
					     its text. `disabled` plus the `busy` guard in reveal() are both
					     load-bearing — this is the one action that cannot happen twice. -->
					<button
						id="reveal"
						onclick={reveal}
						disabled={busy}
						class="btn btn-ember mt-6 w-full py-3 text-sm"
					>
						{#if busy}
							<span class="pulse-dot inline-block h-2 w-2 rounded-full bg-black/70"></span>
							{status || 'Working…'}
						{:else if needsPassphrase}
							Unlock and save
						{:else}
							Reveal and destroy Cinder's stored copy
						{/if}
					</button>
				</div>
			{:else if view === 'delivered' && saved}
				<div in:fade={{ duration: 400 }}>
					<div class="mb-4 flex items-center gap-2 text-xs font-medium text-ember-ink">
						<span class="pulse-dot inline-block h-2 w-2 rounded-full bg-ember"></span>
						Delivered. Copy it somewhere safe before you leave.
					</div>

					<!-- Every row below is a fact. Four are entailed by the bytes this
					     page is holding — the server cannot return a body until the
					     delete and the absence check have both succeeded. The fifth is
					     entailed by the key never having left the fragment. -->
					<div class="record">
						<div class="record-row">
							<span class="record-label">File</span>
							<span class="record-value truncate">{saved.name}</span>
						</div>
						<div class="record-row">
							<span class="record-label">Size</span>
							<span class="record-value">{humanSize(saved.bytes.length)}</span>
						</div>
						<div class="record-row">
							<span class="record-label">Delivery</span>
							<span class="record-value"><span class="record-mark"></span>Consumed</span>
						</div>
						<div class="record-row">
							<span class="record-label">Stored copy</span>
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
				<div in:fade={{ duration: 300 }} class="text-center">
					<h1 class="text-lg font-semibold">This transfer is gone</h1>
					<p class="mt-2 text-sm text-mist">
						Cinder has no stored copy to return. That is all it can tell you.
					</p>
					<a href="/" class="btn btn-ghost mt-6 px-5 py-2.5 text-sm">Send your own</a>
				</div>
			{:else if view === 'lost'}
				<div in:fade={{ duration: 300 }} class="text-center">
					<h1 class="text-lg font-semibold">The delivery began but could not finish</h1>
					<p class="mt-2 text-sm text-mist">
						Cinder's stored copy was already deleted when the transfer started, so there is nothing
						left to send. This cannot be retried. Ask the sender for a new link.
					</p>
					<a href="/" class="btn btn-ghost mt-6 px-5 py-2.5 text-sm">Go to Cinder</a>
				</div>
			{:else}
				<div in:fade={{ duration: 300 }} class="text-center">
					<h1 class="text-lg font-semibold">Couldn't open this file</h1>
					<p class="mt-2 text-sm text-mist">{errorMsg}</p>
					<a href="/" class="btn btn-ghost mt-6 px-5 py-2.5 text-sm">Go to Cinder</a>
				</div>
			{/if}
		</section>
	</div>
</main>
