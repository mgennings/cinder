<script lang="ts">
	import { fade, fly } from 'svelte/transition';
	import { encryptNote } from '$lib/crypto/note-crypto';
	import { createNote } from '$lib/api';
	import { buildLink } from '$lib/link';
	import CopyLink from '$lib/ui/CopyLink.svelte';
	import Merkaba from '$lib/ui/Merkaba.svelte';

	let text = $state('');
	let passphrase = $state('');
	let usePassphrase = $state(false);
	let ttl = $state('86400'); // default 1 day
	let busy = $state(false);
	let error = $state('');
	let link = $state('');

	const ttlOptions = [
		{ value: '3600', label: '1 hour' },
		{ value: '86400', label: '1 day' },
		{ value: '604800', label: '7 days' }
	];

	async function create() {
		if (!text.trim()) return;
		busy = true;
		error = '';
		try {
			const pass = usePassphrase && passphrase ? passphrase : undefined;
			const { payload, fragmentKey } = await encryptNote(text, pass);
			const id = await createNote(payload, Number(ttl));
			link = buildLink(location.origin, id, fragmentKey);
		} catch (e) {
			error = e instanceof Error ? e.message : 'Something went wrong.';
		} finally {
			busy = false;
		}
	}

	function reset() {
		text = '';
		passphrase = '';
		usePassphrase = false;
		link = '';
		error = '';
	}
</script>

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
				A note that's read once, then gone. Encrypted in your browser — we never see it.
			</p>
		</header>

		{#if link}
			<section
				in:fly={{ y: 12, duration: 350 }}
				class="rounded-2xl border border-line bg-ink-soft p-6"
			>
				<h2 class="mb-1 text-sm font-semibold text-ember-soft">Your one-time link is ready</h2>
				<p class="mb-4 text-xs text-ghost">It self-destructs the moment it's read.</p>
				<CopyLink {link} />
				<button
					onclick={reset}
					class="mt-5 text-xs text-mist underline-offset-4 hover:text-white hover:underline"
				>
					Write another note
				</button>
			</section>
		{:else}
			<section class="rounded-2xl border border-line bg-ink-soft p-6">
				<textarea
					bind:value={text}
					placeholder="Type your secret. It never leaves this device unencrypted."
					rows="6"
					class="w-full resize-none rounded-xl border border-line bg-ink px-4 py-3 text-[15px] leading-relaxed text-white placeholder:text-ghost focus:border-ember/50 focus:outline-none"
				></textarea>

				<div class="mt-4 flex flex-wrap items-center gap-4">
					<label class="flex items-center gap-2 text-sm text-mist">
						<span>Burns after</span>
						<select
							bind:value={ttl}
							class="rounded-lg border border-line bg-ink px-2 py-1.5 text-sm text-white focus:outline-none"
						>
							{#each ttlOptions as opt (opt.value)}
								<option value={opt.value}>{opt.label}</option>
							{/each}
						</select>
						<span>if unread</span>
					</label>

					<label class="flex cursor-pointer items-center gap-2 text-sm text-mist">
						<input type="checkbox" bind:checked={usePassphrase} class="accent-ember" />
						Add a passphrase
					</label>
				</div>

				{#if usePassphrase}
					<div in:fade={{ duration: 200 }} class="mt-3">
						<input
							type="password"
							bind:value={passphrase}
							placeholder="Passphrase (needed to open, on top of the link)"
							class="w-full rounded-xl border border-line bg-ink px-4 py-2.5 text-sm text-white placeholder:text-ghost focus:border-ember/50 focus:outline-none"
						/>
						<p class="mt-1.5 text-xs text-ghost">
							Two-factor: the reader needs both the link and this passphrase. Share the passphrase
							separately.
						</p>
					</div>
				{/if}

				{#if error}
					<p in:fade class="mt-3 text-sm text-ember">{error}</p>
				{/if}

				<button
					onclick={create}
					disabled={busy || !text.trim()}
					class="mt-5 w-full rounded-xl py-3 text-sm font-semibold transition-all
						{busy || !text.trim()
						? 'cursor-not-allowed border border-line bg-transparent text-ghost'
						: 'bg-ember text-black shadow-[0_4px_20px_-4px_rgba(255,107,74,0.5)] hover:scale-[1.01] hover:bg-ember-soft active:scale-[0.99]'}"
				>
					{busy ? 'Sealing…' : 'Create one-time link'}
				</button>
			</section>
		{/if}

		<footer class="mt-8 text-center text-xs text-ghost">
			<a href="/security" class="underline-offset-4 hover:text-mist hover:underline"
				>How private is this, really?</a
			>
		</footer>
	</div>
</main>
