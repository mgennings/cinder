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
	import {
		startCheckout,
		isEntitled,
		signedIn,
		identityConfigured,
		startSignIn
	} from '$lib/auth';
	import { MAX_FILE_BYTES } from '$lib/crypto/file-crypto';

	type State = 'loading' | 'signed-out' | 'ready' | 'owned' | 'unavailable';

	let view = $state<State>('loading');
	let working = $state(false);
	let error = $state('');
	// One live region for the page, matching /account: every state change writes a
	// sentence here rather than leaving a screen reader to infer it from a button
	// that quietly changed label.
	let announcement = $state('');

	const dur = (ms: number) => (prefersReducedMotion.current ? 0 : ms);
	const freeLabel = `${Math.round(MAX_FILE_BYTES / (1024 * 1024))} MiB`;

	// The price, written once. It is the only number on this page that has to
	// agree with something outside this repository — the Stripe Price object —
	// and docs/pro-payments.md is where that agreement is checked.
	const PRICE = '$0.94';

	onMount(async () => {
		if (!identityConfigured()) {
			view = 'unavailable';
			announcement = 'Cinder Pro is not available in this build.';
			return;
		}
		if (!signedIn()) {
			view = 'signed-out';
			announcement = 'Sign in to buy Cinder Pro.';
			return;
		}
		if (await isEntitled()) {
			view = 'owned';
			announcement = 'Cinder Pro is already active on this account.';
			return;
		}
		view = 'ready';
		announcement = `Cinder Pro is a one-time ${PRICE}.`;
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
		content="A one-time unlock for sending larger files. What Stripe sees, what Cinder does not, and why a payment is never linked to a note."
	/>
</svelte:head>

<main class="mx-auto w-full max-w-2xl px-5 py-12">
	<p aria-live="polite" class="sr-only">{announcement}</p>

	<h1 class="text-2xl font-semibold text-body">Cinder Pro</h1>
	<p class="mt-3 text-base leading-relaxed text-mist">
		A one-time {PRICE}. It raises the size of what you can send past {freeLabel} and changes nothing
		else. Not a subscription, not a plan, not a renewal — you buy it once.
	</p>

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
				them down. what we keep is one line: this account bought pro, on this date. there is no
				name, no address, and no card on our side to lose.
			</li>
			<li>
				a payment is never linked to a note. notes and file transfers carry no account at all, so
				there is nothing to link them to. stripe is told only a random one-time reference that we
				delete as soon as your purchase lands — after that, nothing anywhere connects a payment to
				you.
			</li>
		</ul>
		<p class="mt-4 text-xs leading-relaxed text-ghost">
			refunds and receipts go through stripe, because they are the only ones who know who paid.
		</p>
	</section>

	{#if view === 'loading'}
		<p class="mt-8 text-sm text-ghost">Checking this account…</p>
	{:else if view === 'unavailable'}
		<p class="mt-8 text-sm leading-relaxed text-mist">
			Cinder Pro is not available in this build. Everything up to {freeLabel} works exactly as it
			always has.
		</p>
	{:else if view === 'signed-out'}
		<div in:fade={{ duration: dur(200) }} class="mt-8">
			<p class="text-sm leading-relaxed text-mist">
				Pro needs an account, because something has to remember you paid. Sending does not, and
				never will — an account is only ever about the purchase.
			</p>
			<div class="mt-4 flex flex-wrap gap-3">
				<button class="btn btn-ghost" onclick={() => startSignIn('SignInWithApple')}>
					Continue with Apple
				</button>
				<button class="btn btn-ghost" onclick={() => startSignIn('Google')}>Continue with Google</button>
			</div>
		</div>
	{:else if view === 'owned'}
		<p in:fade={{ duration: dur(200) }} class="mt-8 text-sm leading-relaxed text-mist">
			This account already has Cinder Pro. There is nothing to buy again, and Cinder will not
			charge you a second time for it.
		</p>
	{:else}
		<div in:fade={{ duration: dur(200) }} class="mt-8">
			<button class="btn btn-ember" onclick={buy} disabled={working}>
				{working ? 'Opening Stripe…' : `Pay ${PRICE} once`}
			</button>
			<p class="mt-3 text-xs text-ghost">This opens Stripe. You can stop there and pay nothing.</p>
		</div>
	{/if}

	{#if error}
		<p in:fade={{ duration: dur(200) }} role="alert" class="mt-4 text-sm text-ember">{error}</p>
	{/if}
</main>
