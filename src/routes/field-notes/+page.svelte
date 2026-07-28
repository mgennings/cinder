<script lang="ts">
	import BenchPage from '$lib/ui/templates/BenchPage.svelte';
	import Button from '$lib/ui/atoms/Button.svelte';
	import Card from '$lib/ui/atoms/Card.svelte';
	import RuleHead from '$lib/ui/atoms/RuleHead.svelte';
	import Record from '$lib/ui/molecules/Record.svelte';
	import RecordRow from '$lib/ui/molecules/RecordRow.svelte';
	import TruthCard from '$lib/ui/molecules/TruthCard.svelte';
	// House format, and it is not optional: plain words first, technical record
	// second, on one page. The people most affected by a privacy decision are
	// rarely the people who can read a config file, so they read first.
	//
	// The signature is the same `.record` panel the transfer receipt uses. A
	// decision gate and a delivery receipt are the same kind of object — a
	// readout whose every row has to be true — so they share a component rather
	// than inventing a second visual language for prose.
	const record = [
		{ label: 'Gate', value: 'Cinder / abuse resistance' },
		{ label: 'Date', value: '2026-07-27' },
		{ label: 'Verdict', value: 'Stay request-blind' },
		{ label: 'Cost', value: 'Accept being knocked offline' },
		{ label: 'Vote', value: '12 of 12, unanimous' }
	];

	const retained = [
		{
			mechanism: 'Request sampling',
			keeps: 'Client IP, full request path, and headers on a rolling 3-hour window. A required field defaulting to on, and not governed by the logging configuration. The note-burn route carries the note key in that path.'
		},
		{
			mechanism: 'Rate-based managed keys',
			keeps: 'Up to 10,000 client addresses currently being limited, retrievable through a public API whenever aggregation is by address.'
		},
		{
			mechanism: 'Firewall metrics',
			keeps: 'Country (derived from address) and device (derived from browser) at fifteen-month retention.'
		},
		{
			mechanism: 'Coverage gap',
			keeps: 'Uploads go browser-to-storage through a pre-signed authorization, structurally bypassing the edge on the only route that moves megabytes.'
		}
	];

	const wrong = [
		{
			claim: 'The finalize role cannot read a stored object',
			reality: 'Reading an object’s metadata requires the permission to read the object. No permission set expresses “metadata but never the body”.'
		},
		{
			claim: 'Subresource Integrity mitigates the served-code risk',
			reality: 'Not deployed, and useless on a first-party origin — whoever can alter the code can alter the integrity attribute beside it.'
		},
		{
			claim: 'Gateway throttling resists link guessing',
			reality: 'Measured: 600 requests admitted in 0.59 s against a configured burst of 40. Entropy defeats guessing; the throttle does not.'
		},
		{
			claim: 'The concurrency cap bounds the bill at about $14/day',
			reality: 'That figure covers compute only. It bounds neither gateway requests, nor database writes, nor storage from abandoned uploads.'
		}
	];
</script>

<svelte:head>
	<title>Field Note 001 — The Vote To Stay Blind · Cinder</title>
	<link rel="canonical" href="https://cinder.ink/field-notes" />
	<meta property="og:url" content="https://cinder.ink/field-notes" />
	<meta
		name="description"
		content="A privacy tool was asked to defend itself, and every defense on offer required it to start looking at who its users were. What was measured, what it cost, and why the answer generalizes."
	/>
	<meta
		name="twitter:description"
		content="A privacy tool was asked to defend itself, and every defense on offer required it to start looking at who its users were. What was measured, what it cost, and why the answer generalizes."
	/>
</svelte:head>

<BenchPage>
	<p class="util mt-8">
		Field note 001 · Decision gate
	</p>
	<h1 class="mt-3 text-3xl font-bold tracking-tight">The vote to stay blind</h1>

	<Record class="mt-7">
		{#each record as row (row.label)}
			<RecordRow label={row.label}>{row.value}</RecordRow>
		{/each}
	</Record>

	<!-- ── Half one: for everybody ─────────────────────────────────────── -->
	<RuleHead class="mt-12">In plain words</RuleHead>

	<div class="mt-4 space-y-4 text-[15px] leading-relaxed text-mist">
		<p>
			Cinder does one thing. You give it a file, it locks the file in your own browser before
			anything leaves your computer, and it hands you a link. The first person to open that link gets
			the file, and Cinder erases its copy in the same breath. Cinder never holds the key, so it
			could not read your file even if someone made it try.
		</p>
		<p>
			Someone asked a fair question: what happens if a stranger floods it with traffic? That costs
			money, and it can knock the service offline.
		</p>
		<p>
			The normal way to stop that is to have the service watch where every request is coming from and
			turn away anyone asking too often. It is what nearly every website does. It is cheap and it
			works.
		</p>
		<p>
			But watching where requests come from means keeping a note of who is asking. For a tool whose
			entire purpose is not knowing who you are, that is not a small thing. It is the thing.
		</p>
		<p>So we measured instead of assuming, and found two facts that settled it.</p>
		<p>
			<strong class="font-medium text-body">The first:</strong> the defense would not have worked here
			anyway. Someone determined could take Cinder offline from a single laptop, and spreading the same
			traffic across twenty connections slips under any limit gentle enough not to hurt real people.
		</p>
		<p>
			<strong class="font-medium text-body">The second:</strong> that kind of limit hurts real people
			first. It works by address, and enormous numbers of people share one — everyone on a phone
			network, everyone at a school or a library, everyone using a VPN. Many of them use a VPN
			precisely because they need privacy. A privacy tool that shuts out the people who most need
			privacy has protected no one.
		</p>
		<p>
			So Cinder chose to stay blind. Under a flood it slows down and turns people away, and it does
			that by simply running out of room rather than by recognizing anybody. Nothing is lost when this
			happens: a request that gets turned away never reaches the part that erases your file, so your
			link still works once the flood passes. The honest cost is that Cinder can be pushed offline.
			We decided we would rather be knocked down than start keeping track of people.
		</p>
	</div>

	<Card class="mt-6 border-l-2 border-l-ember p-5">
		<h3 class="font-medium text-body">One more thing, and it is the uncomfortable part</h3>
		<p class="mt-2 text-sm leading-relaxed text-mist">
			While checking all this, we found that Cinder had been lying. When it was too busy to start, it
			told people their file had been permanently destroyed — while the file sat there, perfectly
			fine. Worse, the protection added that same morning made the false message happen more often.
			We had built something that generated a lie about the one promise the product exists to keep.
			That is fixed, and it is written down here rather than quietly patched, because a tool that asks
			you to trust it does not get to hide its own mistakes.
		</p>
	</Card>

	<RuleHead class="mt-12">Why this document is also the test</RuleHead>
	<div class="mt-4 space-y-4 text-[15px] leading-relaxed text-mist">
		<p>
			The PDF of this note was sent through Cinder before it was published. Not a stand-in, not a
			test file: this exact document, through the live product, the same way a stranger would.
		</p>
		<p>
			That practice has a name — <strong class="font-medium text-body">dogfooding</strong>, using your
			own product for real work instead of only testing it. It matters because of something that
			happened here.
		</p>
		<p>
			Cinder's tests compared files before and after and confirmed they matched perfectly. Every one
			passed. But the files those tests used were made up — long runs of predictable filler, named to
			look like documents. A file like that can survive a round trip flawlessly and prove almost
			nothing, because it was never a real document to begin with. It has no structure to break.
		</p>
		<p>
			The gap showed up the moment a real one was tried. A file arrived that would not open, and it
			looked like Cinder had corrupted it. It had not: the file had been empty filler all along, and
			Cinder returned it exactly as received, faithfully preserving something that was already
			broken. The tests were right and useless at the same time.
		</p>
		<p>
			<strong class="font-medium text-body"
				>Matching before and after is not the same as working.</strong
			> A test that only asks whether the bytes survived can pass forever while the product fails the
			person holding the file. The only reliable check is to send the real thing and then open it.
		</p>
	</div>

	<!-- ── Half two: for engineers ─────────────────────────────────────── -->
	<hr class="mt-12 border-line" />
	<RuleHead class="mt-10">The technical record</RuleHead>
	<p class="mt-3 text-sm leading-relaxed text-ghost">
		Measured against the live production system, not a local copy or a simulation.
	</p>

	<h3 class="mt-8 font-medium text-body">The promise being defended</h3>
	<p class="mt-2 text-sm leading-relaxed text-mist">
		Exactly one server delivery attempt per link, up to 4 MiB. Not one recipient and not a guaranteed
		download, because a server cannot observe either. Bytes, filename, and MIME type are encrypted in
		the browser with AES-256-GCM into one authenticated envelope; the key lives only in the URL
		fragment and is never transmitted. Before any response byte exists, the stored object is deleted
		and its absence verified — so receiving the bytes entails the deletion already happened. The
		transport is a fully buffered proxy integration with no streaming path, which makes that ordering
		structural rather than sequenced.
	</p>

	<h3 class="mt-8 font-medium text-body">The rejected option, and what it retains</h3>
	<Record class="mt-3">
		{#each retained as r (r.mechanism)}
			<RecordRow label={r.mechanism} stacked class="text-mist">{r.keeps}</RecordRow>
		{/each}
	</Record>

	<h3 class="mt-8 font-medium text-body">The measurements that decided it</h3>
	<pre class="field mt-3 overflow-x-auto px-4 py-3 font-mono text-[12px] leading-relaxed text-ember-ink">40 concurrent claims   → exactly 10 × 200, 30 × 503
warm service time      ≈ 165 ms
10 slots ÷ 0.165 s     ≈ 61 req/s sustains total denial, from one machine
request cost           &lt; 200 bytes

during the flood       Throttles 286 · Invocations 27 · Errors 0
                       ConcurrentExecutions Maximum = 10.0 exactly</pre>
	<p class="mt-3 text-sm leading-relaxed text-mist">
		A shed request never enters the function. It reads no record, writes no log line, and never
		reaches the conditional delete — so a flood denies delivery but cannot consume a transfer. That is
		a provable negative. Per-address counters inside a managed firewall are not: their emptiness is a
		claim about a third party's internals that neither a user nor the operator can verify. And ~60
		req/s spread across ~20 addresses defeats any threshold humane enough to avoid blocking shared
		egress, so the control would have purchased the surveillance without the protection.
	</p>

	<h3 class="mt-8 font-medium text-body">Four claims that did not survive audit</h3>
	<div class="mt-3 space-y-3">
		{#each wrong as w (w.claim)}
			<TruthCard level={4} title={w.claim} body={w.reality} />
		{/each}
	</div>

	<h3 class="mt-8 font-medium text-body">What shipped instead</h3>
	<p class="mt-2 text-sm leading-relaxed text-mist">
		Per-function reserved concurrency of ten — a boundary that sheds by exhaustion, never by identity.
		An alarm on shed deliveries so the outage is not silent. A monthly cost guard. Object keys banded
		by lifetime so a one-hour transfer's ciphertext is swept the next day rather than the eighth. And
		log retention pinned in infrastructure code rather than left at the default of forever.
	</p>

	<h3 class="mt-8 font-medium text-body">The transferable principle</h3>
	<Record class="mt-3">
		<RecordRow label="One">A refusal is not a destruction</RecordRow>
		<RecordRow label="Two">Prefer guarantees whose shape makes failure impossible</RecordRow>
		<RecordRow label="Three">A control's data appetite is part of its price</RecordRow>
		<RecordRow label="Four">Audit the protection you just shipped</RecordRow>
		<RecordRow label="Five">Byte-identical is not the same as usable</RecordRow>
	</Record>

	<p class="mt-8 border-l-2 border-ember pl-4 text-sm leading-relaxed text-ghost">
		Cinder is open source. The measurements, the corrections, and the code that makes these claims
		true are all public — including the four claims that were wrong before they were right.
	</p>

	<div class="mt-10 flex flex-wrap gap-3">
		<Button href="/security" class="px-5 py-2.5 text-sm">How private is this, really?</Button>
		<Button href="/" class="px-5 py-2.5 text-sm">Send something</Button>
	</div>
</BenchPage>
