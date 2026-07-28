<script lang="ts">
	import BenchPage from '$lib/ui/templates/BenchPage.svelte';
	import Button from '$lib/ui/atoms/Button.svelte';
	import RuleHead from '$lib/ui/atoms/RuleHead.svelte';
	import Card from '$lib/ui/atoms/Card.svelte';
	import TruthList from '$lib/ui/organisms/TruthList.svelte';
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

	// The file promise is narrower than the note promise, and the difference
	// matters enough to say separately rather than fold into the list above.
	const files: Row[] = [
		{
			title: 'One server delivery attempt',
			body: 'That is the exact promise, and it is narrower than "one download." Cinder allows a single atomic claim on a file. It deletes its own encrypted stored copy and confirms the copy is gone before any response byte exists — so holding the bytes is itself proof the deletion already happened.'
		},
		{
			title: 'Sender-only availability',
			body: 'The browser that creates a file keeps a separate status capability on that device. If that same browser revisits the link, it can ask whether the transfer is available or gone without claiming it. The recipient link does not carry this capability. Cinder returns no identity or timestamp, but repeated checks can reveal when availability changed.'
		},
		{
			title: 'A failed delivery is permanent',
			body: 'If the connection drops after the claim, Cinder has already deleted its copy and will not recreate it. There is no retry, no resume, and no second attempt. This is the cost of the guarantee above, and it is real: ask the sender for a new link.'
		},
		{
			title: 'The filename is encrypted too',
			body: 'The file name and its type are encrypted inside the same authenticated envelope as the bytes. A stored object reveals its size and nothing else — not what the file is called, not what kind of file it is. In a multi-piece transfer the name is encrypted once, into the first piece, rather than repeated in every one.'
		},
		{
			title: 'A large file arrives in pieces',
			body: 'Above 4 MiB, a file is split into pieces of 4 MiB or less, and each piece is a separate encrypted object with its own single delivery attempt. Nothing about the promise changes at a larger size — the same atomic claim, the same delete, the same verified absence, once per piece. The size limit exists because one server response is capped, and more responses was the honest way past it. Sending the whole file in one streamed response would have raised the ceiling by trading a guarantee we can prove for one you would have to take on trust.'
		},
		{
			title: 'One piece failing destroys the whole transfer',
			body: 'This is the real cost of the design and we will not soften it. Pieces are claimed in order, and each one is deleted before it is handed over. If the fifth of twelve fails, the first five are already destroyed, the file cannot be assembled, and there is no retry and no resume — a piece Cinder has deleted cannot be delivered a second time. The recipient is told the number of pieces and this exact consequence before they press anything. Any pieces not yet claimed are abandoned to the same scheduled cleanup that collects a cancelled upload.'
		},
		{
			title: 'Paying does not change what we can see',
			body: 'A paid transfer is encrypted the same way, stored the same way, and deleted the same way. Cinder\u2019s account system runs on a separate API that transfer requests cannot reach: sending a file carries no account token, and the transfer API will not even accept the header one would travel in. What a large send presents is a signed permission slip that says what may be done and nothing about who is doing it. We can tell that someone entitled to send a large file did so. We cannot tell who, and we did not build the ability to find out.'
		},
		{
			title: 'What Cinder still cannot control',
			body: 'Copies saved by the sender, the recipient, a browser, an operating system, or another service remain outside Cinder’s control. Deleting our stored copy is the only deletion any server can honestly promise.'
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
			body: 'We hide the contents of a note, not the fact that a note exists, its rough size, or its timestamps. For a file sent in pieces, we also see how many pieces there are, which is roughly the total size.'
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
	<link rel="canonical" href="https://cinder.ink/security" />
	<meta property="og:url" content="https://cinder.ink/security" />
	<meta
		name="description"
		content="An honest account of what Cinder's zero-knowledge encryption protects against — and what it can't."
	/>
	<meta property="og:description" content="An honest account of what Cinder's zero-knowledge encryption protects against — and what it can't." />
	<meta name="twitter:description" content="An honest account of what Cinder's zero-knowledge encryption protects against — and what it can't." />
</svelte:head>

<BenchPage>
	<h1 class="mt-8 text-2xl font-bold">How private is this, really?</h1>
	<p class="mt-3 leading-relaxed text-mist">
		Cinder is zero-knowledge: your note is encrypted in your browser and the key travels only in the
		link's fragment, which browsers never send to a server. We store ciphertext we cannot read. But
		a privacy tool that oversells itself is worse than one that's honest, so here is the whole
		picture.
	</p>

	<TruthList title="What Cinder protects" rows={protects} />
	<TruthList title="Sending a file" rows={files} />
	<TruthList title="What Cinder can't protect" rows={cannot} />

	<RuleHead class="mt-10">Accounts</RuleHead>
	<!-- Not a TruthCard: this body carries a link, and a card whose body is a
	     plain string cannot hold one. The exception is deliberate rather than an
	     oversight — widening TruthCard to accept markup would let every other
	     claim on this page grow arbitrary structure. -->
	<Card class="mt-4 p-4">
		<h3 class="font-medium text-body">Sending needs no account, and never will</h3>
		<p class="mt-1 text-sm leading-relaxed text-mist">
			Cinder Pro will add a sign-in so a purchase can be honored on more than one browser. It stores
			an opaque number from Apple or Google, one-way hashed, and whether you bought something — no
			email, no name, nothing joinable to a note or a transfer. The full account page states every
			stored field: <a class="text-ember-ink underline" href="/account">what an account stores</a>.
		</p>
	</Card>

	<p class="mt-10 text-sm text-ghost">
		The short version: trust the link to a person, not the internet. Cinder removes our ability to read
		your note — it can't remove your responsibility to share the link carefully.
	</p>

	<div class="mt-8 flex flex-wrap gap-3">
		<Button href="/" class="px-5 py-2.5 text-sm">Send something</Button>
		<Button href="/field-notes" class="px-5 py-2.5 text-sm">Read a decision gate</Button>
	</div>
</BenchPage>
