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
	import SignInPanel from '$lib/ui/SignInPanel.svelte';
	import { MAX_FILE_BYTES, MAX_TRANSFER_BYTES } from '$lib/crypto/file-crypto';
	import { PRO_PRICE, PRO_CREDITS, creditWord } from '$lib/pro';

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
	<meta
		name="description"
		content="Prepaid credits for sending larger files. What a credit buys, what Stripe sees, what Cinder does not, and why a payment is never linked to a note."
	/>
</svelte:head>

<main class="bench mx-auto w-full max-w-2xl px-5 py-12">
	<p aria-live="polite" class="sr-only">{announcement}</p>

	<h1 class="text-2xl font-semibold text-body">Cinder Pro</h1>
	<p class="mt-3 text-base leading-relaxed text-mist">
		{PRICE} for {PRO_CREDITS} large sends, each one up to the {maxProLabel} ceiling. Not a subscription,
		not a plan, not a renewal — the credits sit there until you use them, and anything under
		{freeLabel} stays free forever, with no account.
	</p>

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

	<!-- The disclosure. Deliberately ABOVE the button, in lowercase, in the plain
	     register the product uses when it has something real to admit. It is not
	     a fine-print block and it is not collapsed behind a link. -->
	<section
		aria-labelledby="money-heading"
		class="mt-8 rounded-lg border border-line bg-ink-raised px-5 py-5"
	>
		<h2 id="money-heading" class="text-sm font-semibold text-body">
			what happens when you pay
		</h2>
		<ul class="mt-3 space-y-3 text-sm leading-relaxed text-mist">
			<li>
				cinder still never sees your file, its name, or your key. paying does not change that and
				it does not change how a transfer works. the encryption happens on your device before
				anything is sent, and it happens the same way whether you paid or not.
			</li>
			<li>
				stripe handles the payment. you type your card on stripe's own page, not on cinder's — we
				never render a card field and could not read one if we did. stripe sees your card and
				collects an email address for the receipt.
			</li>
			<li>
				cinder never asks stripe for your card or your email, never reads them, and never writes
				them down. what we keep is one line: this account has this many sends left, and the date it
				last bought some. there is no name, no address, and no card on our side to lose.
			</li>
			<li>
				a payment is never linked to a note. notes and file transfers carry no account at all, so
				there is nothing to link them to. stripe is told only a random one-time reference that we
				delete as soon as your purchase lands — after that, nothing anywhere connects a payment to
				you.
			</li>
			<li>
				a credit is spent when cinder gives your browser permission to send big, which happens
				before your file is encrypted or uploaded — not when the link appears, and not when the
				file arrives. that permission lasts about fifteen minutes and lives in the tab that
				asked for it, so anything else you start there costs nothing extra, while a reload or a
				second tab asks again and spends another. cancel before the link appears and the credit
				is still spent.
			</li>
			<li>
				if a delivery breaks partway, the pieces are destroyed and the credit is gone. cinder has
				no way to see which transfer failed, which is the same reason it can never see who you
				sent it to. credits do not expire and they never come back.
			</li>
		</ul>
		<p class="mt-4 text-xs leading-relaxed text-ghost">
			receipts and any refund of the purchase itself go through stripe, because they are the only
			ones who know who paid. a spent credit is not refundable by anyone, including us.
		</p>
	</section>

	{#if view === 'loading'}
		<p class="mt-8 text-sm text-ghost">Checking this account…</p>
	{:else if view === 'unavailable'}
		<p class="mt-8 text-sm leading-relaxed text-mist">
			Cinder Pro is not available in this build. Everything up to {freeLabel} works exactly as it
			always has.
		</p>
	{:else if view === 'signed-out' || view === 'expired'}
		<div in:fade={{ duration: dur(200) }} class="mt-8 max-w-sm">
			<p class="mb-4 text-sm leading-relaxed text-mist">
				{#if view === 'expired'}
					That session ended, so this browser cannot buy anything right now. Nothing was charged.
					Signing in again puts you straight back on this page with whatever balance you had.
				{:else}
					Pro needs an account, because something has to remember you paid. Sending does not, and
					never will — an account is only ever about the purchase.
				{/if}
			</p>
			<!-- returnTo is the whole point of this being a panel rather than a link
			     to the door: somebody who signs in from the pay point comes back to
			     the pay point, ready to buy, instead of landing on /account with the
			     thing they wanted two clicks away. -->
			<SignInPanel verb="Continue" returnTo="/pro" onstatus={(s) => (announcement = s)} />
		</div>
	{:else}
		<div in:fade={{ duration: dur(200) }} class="mt-8">
			<button class="btn btn-ember" onclick={buy} disabled={working}>
				{working ? 'Opening Stripe…' : `Pay ${PRICE} for ${PRO_CREDITS} sends`}
			</button>
			<p class="mt-3 text-xs text-ghost">This opens Stripe. You can stop there and pay nothing.</p>
		</div>
	{/if}

	{#if error}
		<p in:fade={{ duration: dur(200) }} role="alert" class="mt-4 text-sm text-ember">{error}</p>
	{/if}
</main>
