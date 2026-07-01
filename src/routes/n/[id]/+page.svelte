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

		<section class="rounded-2xl border border-line bg-ink-soft p-6">
			{#if view === 'gate'}
				<div class="text-center">
					<h1 class="text-lg font-semibold">Someone left you a one-time note</h1>
					<p class="mt-2 text-sm text-mist">
						Opening it destroys it — you can only read it once. Make sure you're ready.
					</p>

					{#if needsPassphrase}
						<div in:fade={{ duration: 200 }} class="mt-5 text-left">
							<input
								type="password"
								bind:value={passphrase}
								onkeydown={(e) => e.key === 'Enter' && reveal()}
								aria-label="Passphrase" placeholder="Enter the passphrase"
								class="w-full rounded-xl border border-line bg-ink px-4 py-2.5 text-sm text-body placeholder:text-ghost focus:border-ember/50 focus:outline-none"
							/>
							{#if errorMsg}
								<p class="mt-2 text-sm text-ember">{errorMsg}</p>
							{/if}
						</div>
					{/if}

					<button
						onclick={reveal}
						disabled={busy}
						class="mt-6 w-full rounded-xl py-3 text-sm font-semibold transition-all
							{busy
							? 'cursor-not-allowed border border-line bg-transparent text-ghost'
							: 'bg-ember text-black shadow-[0_4px_20px_-4px_rgba(255,107,74,0.5)] hover:scale-[1.01] hover:bg-ember-soft active:scale-[0.99]'}"
					>
						{busy ? 'Opening…' : needsPassphrase ? 'Unlock & reveal' : 'Reveal note'}
					</button>
				</div>
			{:else if view === 'revealed'}
				<div in:fade={{ duration: 400 }}>
					<div class="mb-4 flex items-center gap-2 text-xs font-medium text-ember-ink">
						<span class="inline-block h-2 w-2 rounded-full bg-ember"></span>
						This note is now destroyed. Copy anything you need before you leave.
					</div>
					<pre
						class="whitespace-pre-wrap break-words rounded-xl border border-line bg-ink px-4 py-4 text-[15px] leading-relaxed text-body">{plaintext}</pre>
				</div>
			{:else if view === 'gone'}
				<div in:fade={{ duration: 300 }} class="text-center">
					<h1 class="text-lg font-semibold">This note is gone</h1>
					<p class="mt-2 text-sm text-mist">
						It was already read, or it expired. Self-destructing notes only open once.
					</p>
					<a
						href="/"
						class="mt-6 inline-block rounded-xl border border-line px-5 py-2.5 text-sm text-body hover:border-ember/50"
						>Write your own</a
					>
				</div>
			{:else}
				<div in:fade={{ duration: 300 }} class="text-center">
					<h1 class="text-lg font-semibold">Couldn't open this note</h1>
					<p class="mt-2 text-sm text-mist">{errorMsg}</p>
					<a
						href="/"
						class="mt-6 inline-block rounded-xl border border-line px-5 py-2.5 text-sm text-body hover:border-ember/50"
						>Go to Cinder</a
					>
				</div>
			{/if}
		</section>
	</div>
</main>
