<script lang="ts">
	// A DOOR. /signin and /signup are both this, with different words.
	//
	// The two used to be one thing buried inside /account, which meant sign-in
	// had no address you could link to, no address you could bookmark, and no
	// address a refusal could send anybody back to. Giving the journey real URLs
	// is most of what "nail the flow" turned out to mean.
	//
	// THE CALLBACK IS STILL /account, and that is deliberate: the Cognito app
	// client's CallbackURLs list exactly those, and a mismatch between this code
	// and that list breaks sign-in in production with an error page nobody can
	// read. So these doors send you out, /account catches you, and /account
	// forwards you to wherever you were going. Changing that means changing
	// template.yaml and redeploying the pool, which buys a slightly shorter URL
	// bar flicker for a real outage risk. Not worth it.
	import { onMount } from 'svelte';
	import type { Snippet } from 'svelte';
	import { replaceState } from '$app/navigation';
	import { page } from '$app/state';
	import {
		identityConfigured,
		intendedPath,
		sessionState,
		signInFailureMessage,
		type SignInFailure
	} from '$lib/auth';
	import SignInPanel from './SignInPanel.svelte';
	import Card from '../atoms/Card.svelte';
	import Button from '../atoms/Button.svelte';
	import Wordmark from '../atoms/Wordmark.svelte';
	import LiveRegion from '../atoms/LiveRegion.svelte';
	import { terrain } from '../terrain';

	let {
		title,
		lede,
		verb,
		note,
		otherDoor
	}: {
		title: string;
		lede: string;
		verb: string;
		/** The honest paragraph under the buttons. Different per door. */
		note: Snippet;
		/** "New here?" / "Already have one?" — the link to the other door. */
		otherDoor: Snippet;
	} = $props();

	type View = 'loading' | 'ready' | 'signed-in' | 'expired' | 'unavailable';

	let view = $state<View>('loading');
	let announcement = $state('');
	let error = $state('');
	let next = $state<string | null>(null);

	const say = (sentence: string) => (announcement = sentence);

	onMount(async () => {
		next = intendedPath(page.url.search);

		if (!identityConfigured()) {
			view = 'unavailable';
			return say('Accounts are not available in this build.');
		}

		// A door can also be where a failure lands: /account forwards a person
		// back here with the reason, so the retry happens on the surface that
		// started it rather than on a page they never chose.
		const reason = page.url.searchParams.get('failed') as SignInFailure | null;
		if (reason) {
			error = signInFailureMessage(reason, page.url.searchParams.get('detail') ?? undefined);
			say(error);
			// The reason is single-use. Left in the address bar it would reappear
			// on every reload, telling somebody a sign-in failed that never ran.
			const clean = new URL(page.url);
			clean.searchParams.delete('failed');
			clean.searchParams.delete('detail');
			/* SvelteKit's replaceState keeps the router's idea of the URL in step
			   with the address bar, so it is the one to reach for FIRST. But on a
			   direct load of this page the router is not initialized yet and it
			   THROWS, and the rejection aborted the rest of this function: the
			   session was never read, `view` stayed 'loading', and the person sat
			   on "Checking this browser..." with no way forward. That is the exact
			   page a failed sign-in lands on, so the failure path was the one path
			   guaranteed to be dead.

			   Tidying the address bar is a courtesy. Rendering the page is not.
			   The courtesy never gets to cost the page again. */
			try {
				replaceState(clean.pathname + clean.search, {});
			} catch {
				// Before the router exists there is nothing to desync from.
				history.replaceState(null, '', clean.pathname + clean.search);
			}
		}

		const session = await sessionState();
		if (session === 'live') {
			view = 'signed-in';
			return say('You are already signed in.');
		}
		if (session === 'expired') {
			view = 'expired';
			return say('That session ended. Signing in again takes a second.');
		}

		view = 'ready';
		if (!error) say(`${title}.`);
	});
</script>

<main class="auth-arrival">
	<section class="auth-panel" aria-label={title}>
		<div class="auth-panel-inner">
			<Wordmark />

			<LiveRegion message={announcement} />

			<Card class="mt-8 p-6">
				{#if view === 'loading'}
					<p class="text-sm text-mist">Checking this browser…</p>
				{:else if view === 'unavailable'}
					<h1 class="text-xl font-semibold">Accounts are not available yet</h1>
					<p class="mt-2 text-sm leading-relaxed text-mist">
						Cinder Pro has not launched here. Sending under the free size limit works exactly as it
						always has, with no account at all.
					</p>
					<Button href="/" class="mt-5 px-4">Back to Cinder</Button>
				{:else if view === 'signed-in'}
					<h1 class="text-xl font-semibold">You are already signed in</h1>
					<p class="mt-2 text-sm leading-relaxed text-mist">
						Nothing to do here. This browser already holds a session.
					</p>
					<div class="mt-5 flex flex-col gap-2 sm:flex-row">
						<Button variant="ember" class="px-5" href={next ?? '/account'}>Continue</Button>
						{#if next}
							<Button class="px-5" href="/account">Your account</Button>
						{/if}
					</div>
				{:else}
					<h1 class="text-xl font-semibold">{title}</h1>
					<p class="mt-2 mb-5 text-sm leading-relaxed text-mist">
						{#if view === 'expired'}
							That session ended. It was revoked, or it simply ran out. Nothing was lost and nothing
							was charged. Signing in again restores the balance on this account.
						{:else}
							{lede}
						{/if}
					</p>

					<SignInPanel {verb} returnTo={next} {error} onstatus={say} />

					<div class="mt-5 text-sm leading-relaxed text-mist">
						{@render note()}
					</div>
				{/if}
			</Card>

			{#if view === 'ready' || view === 'expired'}
				<p class="mt-6 text-center text-sm text-mist">
					{@render otherDoor()}
				</p>
			{/if}

			<p class="mt-6 text-center text-xs leading-relaxed text-ghost">
				Sending a note or file never needs an account. Accounts only keep a Cinder Pro balance.
			</p>
		</div>
	</section>

	<section class="auth-field vault-glow" {@attach terrain()} aria-labelledby="identity-promise">
		<div class="auth-field-copy">
			<p class="font-mono text-xs font-bold tracking-[0.16em] text-ember-ink uppercase">
				Cinder identity
			</p>
			<h2 id="identity-promise">Remember the balance. Leave the secret&nbsp;alone.</h2>
			<p class="auth-field-lede">
				Your account keeps a Cinder Pro balance with you. Notes and transfers never carry it.
			</p>
			<dl class="auth-proof">
				<div>
					<dt>Purpose</dt>
					<dd>Sign in and keep your balance</dd>
				</div>
				<div>
					<dt>Account data</dt>
					<dd>Never used for tracking or sold</dd>
				</div>
				<div>
					<dt>Notes + transfers</dt>
					<dd>Never attached to an account</dd>
				</div>
			</dl>
		</div>
	</section>
</main>

<style>
	.auth-arrival {
		display: flex;
		flex-wrap: wrap;
		min-height: 100dvh;
	}

	.auth-panel,
	.auth-field {
		min-width: 0;
	}

	.auth-panel {
		display: flex;
		flex: 9 1 28rem;
		align-items: center;
		justify-content: center;
		padding: clamp(2rem, 6vw, 5rem);
	}

	.auth-panel-inner {
		width: min(100%, 32rem);
	}

	.auth-panel h1 {
		text-wrap: balance;
	}

	.auth-field {
		isolation: isolate;
		display: flex;
		flex: 11 1 28rem;
		align-items: center;
		padding: clamp(3rem, 8vw, 8rem);
		box-shadow:
			inset 1px 0 0 var(--color-line),
			inset 0 1px 0 var(--color-line);
	}

	.auth-field-copy {
		position: relative;
		z-index: 1;
		width: min(100%, 38rem);
	}

	.auth-field h2 {
		max-width: 11ch;
		margin-top: 1rem;
		color: var(--color-body);
		font-size: clamp(2.75rem, 6vw, 6rem);
		font-weight: 800;
		line-height: 0.92;
		letter-spacing: -0.06em;
		text-wrap: balance;
	}

	.auth-field-lede {
		max-width: 30rem;
		margin-top: 1.5rem;
		color: var(--color-mist);
		font-size: clamp(1rem, 2vw, 1.25rem);
		line-height: 1.55;
		text-wrap: pretty;
	}

	.auth-proof {
		display: grid;
		gap: 0;
		margin-top: clamp(2rem, 5vw, 4rem);
		border-block: 1px solid var(--color-line);
	}

	.auth-proof > div {
		display: grid;
		grid-template-columns: minmax(7rem, 0.75fr) minmax(0, 1.25fr);
		gap: 1rem;
		padding: 1rem 0;
	}

	.auth-proof > div + div {
		border-block-start: 1px solid var(--color-line);
	}

	.auth-proof dt,
	.auth-proof dd {
		margin: 0;
	}

	.auth-proof dt {
		color: var(--color-ghost);
		font-family: var(--font-mono);
		font-size: 0.75rem;
		font-weight: 700;
		line-height: 1.5;
		letter-spacing: 0.08em;
		text-transform: uppercase;
	}

	.auth-proof dd {
		color: var(--color-body);
		font-size: 0.875rem;
		font-weight: 650;
		line-height: 1.5;
		text-wrap: pretty;
	}

	@media (max-width: 56rem) {
		.auth-panel {
			padding: 2rem 1.25rem;
		}

		.auth-field {
			padding: clamp(2.5rem, 10vw, 5rem) 1.25rem;
		}

		.auth-field-copy {
			width: min(100%, 32rem);
			margin-inline: auto;
		}

		.auth-field h2 {
			max-width: none;
			font-size: clamp(1.75rem, 10vw, 4.5rem);
		}
	}

	@media (max-width: 28rem) {
		.auth-proof > div {
			grid-template-columns: minmax(0, 1fr);
			gap: 0.25rem;
		}
	}
</style>
