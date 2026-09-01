<script lang="ts">
	// The moment money moves, and the only screen on this site that names a third
	// party. Matt's rule, and it is the right one: say who gets what at the moment
	// it happens, not in a policy page nobody opens.
	//
	// EVERY CLAUSE BELOW IS LOAD-BEARING AND EVERY ONE OF THEM IS CHECKED AGAINST
	// CODE. The mapping lives in docs/pro-payments.md, clause by clause, with the
	// file and line that makes each true. If a change makes one of these sentences
	// false, the sentence is not the thing to edit.
	//
	// The one sentence that was WRITTEN DIFFERENTLY from how it was first drafted:
	// the draft said Cinder does not receive the card and email. It does not
	// receive the card — that is true, the fields live on Stripe's own origin. But
	// the webhook payload Stripe posts to us carries customer_details.email
	// whether we want it or not, so "does not receive" would have been false at
	// the HTTP layer even though no line of our code ever reads that field. What
	// is true is that we never ask for it, never read it, and never write it down,
	// so that is what it says. A shipped string may not claim a privacy property
	// the code does not have.
	import { onMount } from 'svelte';
	import { fade } from 'svelte/transition';
	import { prefersReducedMotion } from 'svelte/motion';
	import { startCheckout, entitlement, sessionState, identityConfigured } from '$lib/auth';
	import SignInPanel from '$lib/ui/organisms/SignInPanel.svelte';
	import { MAX_FILE_BYTES, MAX_TRANSFER_BYTES } from '$lib/crypto/file-crypto';
	import { PRO_PRICE, PRO_CREDITS, creditWord } from '$lib/pro';
	import DashboardPage from '$lib/ui/templates/DashboardPage.svelte';
	import Button from '$lib/ui/atoms/Button.svelte';
	import Alert from '$lib/ui/atoms/Alert.svelte';
	import LiveRegion from '$lib/ui/atoms/LiveRegion.svelte';
	import PaymentDisclosure from '$lib/ui/organisms/PaymentDisclosure.svelte';

	// There is no 'owned' state any more, and its absence is the model: credits
	// run down, so the buy button is never the wrong thing to show. What changes
	// with a balance is the sentence next to it, not whether it exists.
	type State = 'loading' | 'signed-out' | 'expired' | 'ready' | 'unavailable';

	let view = $state<State>('loading');
	let credits = $state(0);
	let working = $state(false);
	let error = $state('');
	// One live region for the page, matching /account: every state change writes a
	// sentence here rather than leaving a screen reader to infer it from a button
	// that quietly changed label.
	let announcement = $state('');

	const dur = (ms: number) => (prefersReducedMotion.current ? 0 : ms);
	const freeLabel = `${Math.round(MAX_FILE_BYTES / (1024 * 1024))} MiB`;
	const maxProLabel = `${Math.round(MAX_TRANSFER_BYTES / (1024 * 1024))} MiB`;

	const PRICE = PRO_PRICE;

	onMount(async () => {
		if (!identityConfigured()) {
			view = 'unavailable';
			announcement = 'Cinder Pro is not available in this build.';
			return;
		}
		// Asked of the origin, not of storage. A stale token in this tab used to
		// render the buy button, and the purchase then failed at the server with
		// one generic refusal — the wrong sentence for somebody whose session had
		// simply run out while the tab sat open.
		const session = await sessionState();
		if (session !== 'live') {
			view = session === 'expired' ? 'expired' : 'signed-out';
			announcement =
				session === 'expired'
					? 'That session ended. Sign in again to buy Cinder Pro.'
					: 'Sign in to buy Cinder Pro.';
			return;
		}
		credits = (await entitlement()).credits;
		view = 'ready';
		announcement = credits
			? `${creditWord(credits)} left on this account. ${PRICE} adds ${PRO_CREDITS} more.`
			: `${PRICE} buys ${PRO_CREDITS} large sends.`;
	});

	async function buy() {
		if (working) return;
		working = true;
		error = '';
		announcement = 'Opening the payment page.';

		const url = await startCheckout();
		if (!url) {
			working = false;
			// Every server refusal is one answer, because the server gives one
			// answer. Guessing which of them happened would be inventing detail.
			error = 'Cinder could not start a payment. Nothing was charged.';
			announcement = error;
			return;
		}
		// A navigation, not a fetch and not an iframe. The card fields belong to
		// Stripe's origin and this page never has them in its document.
		location.assign(url);
	}
</script>

<svelte:head>
	<title>Cinder Pro</title>
	<link rel="canonical" href="https://cinder.ink/pro" />
	<meta
		name="description"
		content="Buy 10 Cinder Pro large-send credits for $4.94. No subscription, and files under 4 MiB remain free without an account."
	/>
	<meta property="og:title" content="Cinder Pro" />
	<meta property="og:url" content="https://cinder.ink/pro" />
	<meta
		property="og:description"
		content="Buy 10 Cinder Pro large-send credits for $4.94. No subscription, and files under 4 MiB remain free without an account."
	/>
	<meta name="twitter:title" content="Cinder Pro" />
	<meta
		name="twitter:description"
		content="Buy 10 Cinder Pro large-send credits for $4.94. No subscription, and files under 4 MiB remain free without an account."
	/>
</svelte:head>

<DashboardPage
	current="/pro"
	location="Cinder Pro"
	title="Cinder Pro"
	lede={`${PRICE} for ${PRO_CREDITS} large sends, each one up to the ${maxProLabel} ceiling. Not a subscription, not a plan, not a renewal. The credits sit there until you use them, and anything under ${freeLabel} stays free forever, with no account.`}
>
	<LiveRegion message={announcement} />

	<!-- The balance, stated before the button rather than after the purchase.
	     Someone with credits left needs to know that before they decide whether
	     to buy more, and someone at zero needs to read it as an ordinary state. -->
	{#if view === 'ready'}
		<p in:fade={{ duration: dur(200) }} class="mt-3 text-sm leading-relaxed text-body">
			{credits
				? `You have ${creditWord(credits)} left. Buying again adds ${PRO_CREDITS} more to it.`
				: 'You have no credits right now. Nothing is broken and nothing has expired — small sends work exactly as they always did.'}
		</p>
	{/if}

	{#if view === 'loading'}
		<p class="mt-6 text-sm text-ghost">Checking this account…</p>
	{:else if view === 'unavailable'}
		<p class="mt-6 text-sm leading-relaxed text-mist">
			Cinder Pro is not available in this build. Everything up to {freeLabel} works exactly as it
			always has.
		</p>
	{:else if view === 'signed-out' || view === 'expired'}
		<section in:fade={{ duration: dur(200) }} aria-labelledby="account-heading" class="mt-6 max-w-sm">
			<h2 id="account-heading" class="text-base font-semibold text-body text-balance">
				Sign in or create an account
			</h2>
			<p class="mb-4 mt-2 text-sm leading-relaxed text-mist text-pretty">
				{#if view === 'expired'}
					That session ended. Sign in again to return here with the balance you had. Nothing was
					charged.
				{:else}
					Use Apple or Google. The account remembers only your credit balance and last purchase date;
					notes and transfers remain separate.
				{/if}
			</p>
			<!-- returnTo is the whole point of this being a panel rather than a link
			     to the door: somebody who signs in from the pay point comes back to
			     the pay point, ready to buy, instead of landing on /account with the
			     thing they wanted two clicks away. -->
			<SignInPanel verb="Continue" returnTo="/pro" onstatus={(s) => (announcement = s)} />
		</section>
	{:else}
		<section in:fade={{ duration: dur(200) }} aria-labelledby="purchase-heading" class="mt-6">
			<h2 id="purchase-heading" class="text-sm font-semibold text-body">Before you pay</h2>
			<ul class="mt-2 space-y-1 text-sm leading-relaxed text-mist">
				<li>Stripe handles payment on its own page.</li>
				<li>A credit is spent before encryption or upload, when Cinder approves the large send.</li>
				<li>Spent credits are not refundable, even if you cancel or a delivery fails.</li>
			</ul>
			<Button class="mt-4 w-full sm:w-auto" variant="ember" onclick={buy} disabled={working}>
				{working ? 'Opening Stripe…' : `Pay ${PRICE} for ${PRO_CREDITS} sends`}
			</Button>
			<!-- mist, not ghost. Ghost is placeholder weight and theme.md says so; at
			     12px on the light floor beneath the error fill it measured 4.48:1,
			     which is 0.02 under AA and still under. -->
			<p class="mt-3 text-xs text-mist">This opens Stripe. You can stop there and pay nothing.</p>
		</section>
	{/if}

	{#if error}
		<div in:fade={{ duration: dur(200) }}>
			<Alert class="mt-4">{error}</Alert>
		</div>
	{/if}

	<PaymentDisclosure />
</DashboardPage>
