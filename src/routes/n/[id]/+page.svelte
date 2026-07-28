<script lang="ts">
	import { page } from '$app/state';
	import { fade } from 'svelte/transition';
	import { burnNote, NoteGoneError } from '$lib/api';
	import { decryptNote, type EncryptedPayload } from '$lib/crypto/note-crypto';
	import { parseFragmentKey } from '$lib/link';
	import Card from '$lib/ui/atoms/Card.svelte';
	import Button from '$lib/ui/atoms/Button.svelte';
	import PulseDot from '$lib/ui/atoms/PulseDot.svelte';
	import TextInput from '$lib/ui/atoms/TextInput.svelte';
	import Wordmark from '$lib/ui/atoms/Wordmark.svelte';
	import VaultPage from '$lib/ui/templates/VaultPage.svelte';
	import OutcomePanel from '$lib/ui/organisms/OutcomePanel.svelte';

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
	<meta property="og:title" content="Someone left you a one-time note · Cinder" />
	<meta
		property="og:description"
		content="Encrypted in the sender's browser. Revealing it removes Cinder's stored copy."
	/>
	<meta property="og:image" content="https://cinder.ink/og-note.png" />
	<meta property="og:image:width" content="1200" />
	<meta property="og:image:height" content="630" />
	<meta property="og:image:alt" content="A Cinder one-time note shown on a phone against an encrypted signal landscape" />
	<meta name="twitter:title" content="Someone left you a one-time note · Cinder" />
	<meta name="twitter:image" content="https://cinder.ink/og-note.png" />
</svelte:head>

<VaultPage>
	{#snippet header()}
		<Wordmark />
	{/snippet}

	<Card as="section" class="p-6">
		{#if view === 'gate'}
			<div class="text-center">
				<h1 class="text-lg font-semibold">Someone left you a one-time note</h1>
				<p class="mt-2 text-sm text-mist">
					Reveal removes Cinder's stored copy and opens it here. Cinder cannot erase copies
					captured elsewhere.
				</p>

				{#if needsPassphrase}
					<div in:fade={{ duration: 200 }} class="mt-5 text-left">
						<TextInput
							type="password"
							bind:value={passphrase}
							onkeydown={(e) => e.key === 'Enter' && reveal()}
							aria-label="Passphrase"
							placeholder="Enter the passphrase"
						/>
						{#if errorMsg}
							<p class="mt-2 text-sm text-ember">{errorMsg}</p>
						{/if}
					</div>
				{/if}

				<Button variant="ember" onclick={reveal} disabled={busy} class="mt-6 w-full py-3 text-sm">
					{#if busy}<PulseDot class="bg-black/70" />{/if}
					{busy ? 'Opening…' : needsPassphrase ? 'Unlock & reveal' : 'Reveal note'}
				</Button>
			</div>
		{:else if view === 'revealed'}
			<div in:fade={{ duration: 400 }}>
				<div class="mb-4 flex items-center gap-2 text-xs font-medium text-ember-ink">
					<PulseDot />
					Cinder's stored copy is gone. Copy anything you need before you leave.
				</div>
				<pre
					class="field whitespace-pre-wrap break-words px-4 py-4 text-base leading-relaxed">{plaintext}</pre>
			</div>
		{:else if view === 'gone'}
			<div in:fade={{ duration: 300 }}>
				<OutcomePanel title="This note is gone">
					It was already revealed or expired, so Cinder has no stored copy to return.
					{#snippet action()}
						<Button href="/" class="mt-6 px-5 py-2.5 text-sm">Write your own</Button>
					{/snippet}
				</OutcomePanel>
			</div>
		{:else}
			<div in:fade={{ duration: 300 }}>
				<OutcomePanel title="Couldn't open this note">
					{errorMsg}
					{#snippet action()}
						<Button href="/" class="mt-6 px-5 py-2.5 text-sm">Go to Cinder</Button>
					{/snippet}
				</OutcomePanel>
			</div>
		{/if}
	</Card>
</VaultPage>
