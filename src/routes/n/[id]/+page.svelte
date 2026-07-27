<script lang="ts">
	import { page } from '$app/state';
	import { fade } from 'svelte/transition';
	import { burnNote, NoteGoneError } from '$lib/api';
	import { decryptNote, type EncryptedPayload } from '$lib/crypto/note-crypto';
	import { parseFragmentKey } from '$lib/link';

	type View = 'gate' | 'revealed' | 'gone' | 'error';

	const id = $derived(page.params.id ?? '');
	// The fragment (key) is read from the browser only — it never reached the server.
	let fragmentKey = $state('');
	let view: View = $state('gate');
	let busy = $state(false);
	let passphrase = $state('');
	let needsPassphrase = $state(false);
	let plaintext = $state('');
	let errorMsg = $state('');

	// A burned payload we're holding while we wait for a passphrase.
	let pending: EncryptedPayload | null = $state(null);

	$effect(() => {
		fragmentKey = parseFragmentKey(page.url.hash);
	});

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
			// Burn on the server FIRST (this is the point of no return), then decrypt.
			const payload = pending ?? (await burnNote(id));
			pending = payload;

			if (payload.salt && !passphrase) {
				needsPassphrase = true;
				busy = false;
				return;
			}

			plaintext = await decryptNote(payload, fragmentKey, passphrase || undefined);
			view = 'revealed';
		} catch (e) {
			if (e instanceof NoteGoneError) {
				view = 'gone';
			} else if (needsPassphrase) {
				errorMsg = "That passphrase didn't work. The note is already burned — try again carefully.";
			} else {
				errorMsg = "Couldn't decrypt — the link may be wrong or corrupted.";
				view = 'error';
			}
		} finally {
			busy = false;
		}
	}
</script>

<svelte:head>
	<title>A one-time note · Cinder</title>
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
				<div class="text-center">
					<h1 class="text-lg font-semibold">Someone left you a one-time note</h1>
					<p class="mt-2 text-sm text-mist">
						Reveal removes Cinder's stored copy and opens it here. Cinder cannot erase copies
						captured elsewhere.
					</p>

					{#if needsPassphrase}
						<div in:fade={{ duration: 200 }} class="mt-5 text-left">
							<input
								type="password"
								bind:value={passphrase}
								onkeydown={(e) => e.key === 'Enter' && reveal()}
								aria-label="Passphrase" placeholder="Enter the passphrase"
								class="field px-4 py-2.5 text-sm"
							/>
							{#if errorMsg}
								<p class="mt-2 text-sm text-ember">{errorMsg}</p>
							{/if}
						</div>
					{/if}

					<button onclick={reveal} disabled={busy} class="btn btn-ember mt-6 w-full py-3 text-sm">
						{#if busy}<span class="pulse-dot inline-block h-2 w-2 rounded-full bg-black/70"></span>{/if}
						{busy ? 'Opening…' : needsPassphrase ? 'Unlock & reveal' : 'Reveal note'}
					</button>
				</div>
			{:else if view === 'revealed'}
				<div in:fade={{ duration: 400 }}>
					<div class="mb-4 flex items-center gap-2 text-xs font-medium text-ember-ink">
						<span class="pulse-dot inline-block h-2 w-2 rounded-full bg-ember"></span>
						Cinder's stored copy is gone. Copy anything you need before you leave.
					</div>
					<pre
						class="field whitespace-pre-wrap break-words px-4 py-4 text-base leading-relaxed">{plaintext}</pre>
				</div>
			{:else if view === 'gone'}
				<div in:fade={{ duration: 300 }} class="text-center">
					<h1 class="text-lg font-semibold">This note is gone</h1>
					<p class="mt-2 text-sm text-mist">
						It was already revealed or expired, so Cinder has no stored copy to return.
					</p>
					<a href="/" class="btn btn-ghost mt-6 px-5 py-2.5 text-sm">Write your own</a>
				</div>
			{:else}
				<div in:fade={{ duration: 300 }} class="text-center">
					<h1 class="text-lg font-semibold">Couldn't open this note</h1>
					<p class="mt-2 text-sm text-mist">{errorMsg}</p>
					<a href="/" class="btn btn-ghost mt-6 px-5 py-2.5 text-sm">Go to Cinder</a>
				</div>
			{/if}
		</section>
	</div>
</main>
