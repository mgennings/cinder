<script lang="ts">
	type Row = { title: string; body: string };

	const protects: Row[] = [
		{
			title: 'Server-side exposure',
			body: 'Encryption and decryption happen only in your browser. Our server stores ciphertext, an IV, and (in passphrase mode) a salt — never the key, never the plaintext.'
		},
		{
			title: 'Tampering',
			body: 'We use AES-256-GCM, which is authenticated. If anyone alters the stored blob, decryption fails instead of returning altered content.'
		},
		{
			title: 'A leaked stored blob',
			body: 'Without the key from the link fragment, the stored payload is useless. The key never reaches us.'
		}
	];

	const cannot: Row[] = [
		{
			title: 'A compromised server serving bad JavaScript',
			body: 'This is the fundamental limit of any browser-delivered crypto. Because the same server that stores your note also ships the code that encrypts it, a compromised server could serve modified code that captures your note or key. "Zero-knowledge" holds only while the served code is honest, and no website can cryptographically prove that to you. We state this plainly rather than pretend otherwise.'
		},
		{
			title: 'Anyone who gets the link',
			body: 'The key lives in the link. Whoever holds the full link can read the note once. Send it over a channel you trust, and only to the person you mean.'
		},
		{
			title: 'The link leaking through intermediaries',
			body: 'A full link can land in browser history, browser sync, clipboard managers, or chat backups. We run no third-party analytics on note pages, but your own tools might capture the URL.'
		},
		{
			title: 'Metadata',
			body: 'We hide the contents of a note, not the fact that a note exists, its rough size, or its timestamps.'
		},
		{
			title: 'Weak passphrases',
			body: 'Passphrase mode stretches your passphrase with 600,000 rounds of PBKDF2, which slows guessing — but a weak passphrase is still a weak passphrase.'
		},
		{
			title: 'A compromised device',
			body: 'Malware, a malicious browser extension, or a shared machine can see the note the moment you decrypt it. No web app can protect against that.'
		},
		{
			title: 'A server that quietly keeps a copy',
			body: '"Self-destruct" is a promise our backend keeps by deleting the note, not a law of physics. Anyone who captured the ciphertext and the link before you opened it could still decrypt it.'
		}
	];
</script>

<svelte:head>
	<title>How private is Cinder, really?</title>
	<meta
		name="description"
		content="An honest account of what Cinder's zero-knowledge encryption protects against — and what it can't."
	/>
</svelte:head>

<main class="mx-auto max-w-2xl px-5 py-16">
	<a href="/" class="text-2xl font-bold tracking-tight">Cinder<span class="text-ember">.</span></a>

	<h1 class="mt-8 text-2xl font-bold">How private is this, really?</h1>
	<p class="mt-3 leading-relaxed text-mist">
		Cinder is zero-knowledge: your note is encrypted in your browser and the key travels only in the
		link's fragment, which browsers never send to a server. We store ciphertext we cannot read. But
		a privacy tool that oversells itself is worse than one that's honest, so here is the whole
		picture.
	</p>

	<h2 class="mt-10 text-lg font-semibold text-ember-soft">What Cinder protects</h2>
	<div class="mt-4 space-y-4">
		{#each protects as row (row.title)}
			<div class="rounded-xl border border-line bg-ink-soft p-4">
				<h3 class="font-medium text-white">{row.title}</h3>
				<p class="mt-1 text-sm leading-relaxed text-mist">{row.body}</p>
			</div>
		{/each}
	</div>

	<h2 class="mt-10 text-lg font-semibold text-ember-soft">What Cinder can't protect</h2>
	<div class="mt-4 space-y-4">
		{#each cannot as row (row.title)}
			<div class="rounded-xl border border-line bg-ink-soft p-4">
				<h3 class="font-medium text-white">{row.title}</h3>
				<p class="mt-1 text-sm leading-relaxed text-mist">{row.body}</p>
			</div>
		{/each}
	</div>

	<p class="mt-10 text-sm text-ghost">
		The short version: trust the link to a person, not the internet. Cinder removes our ability to read
		your note — it can't remove your responsibility to share the link carefully.
	</p>

	<a
		href="/"
		class="mt-8 inline-block rounded-xl border border-line px-5 py-2.5 text-sm text-white hover:border-ember/50"
		>Write a note</a
	>
</main>
