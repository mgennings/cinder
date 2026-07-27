<script lang="ts">
	// Where Stripe sends you back to.
	//
	// This page GRANTS NOTHING. Arriving here proves only that a browser followed
	// a redirect, and the URL is guessable by typing it, so anything it decided
	// would be a paywall anyone could walk around. The grant happens in the
	// webhook, server to server, on a signature. All this page does is ask the
	// server what is true and report the answer.
	//
	// Which means it has to tolerate arriving BEFORE the webhook does. Stripe's
	// redirect and Stripe's webhook are independent, and the browser usually wins
	// the race by a second or two. So this polls briefly rather than concluding
	// "not entitled" from the first answer — a person who just paid must never be
	// told they did not.
	import { onMount } from 'svelte';
	import { fade } from 'svelte/transition';
	import { prefersReducedMotion } from 'svelte/motion';
	import { isEntitled, identityConfigured } from '$lib/auth';

	type State = 'waiting' | 'active' | 'slow';

	let view = $state<State>('waiting');
	let announcement = $state('Confirming your purchase.');

	const dur = (ms: number) => (prefersReducedMotion.current ? 0 : ms);

	// Ten tries a second and a half apart. Fifteen seconds is far longer than the
	// webhook takes and short enough that a spinner is not a lie.
	const TRIES = 10;
	const GAP_MS = 1500;

	onMount(async () => {
		if (!identityConfigured()) {
			view = 'slow';
			return;
		}
		for (let i = 0; i < TRIES; i++) {
			if (await isEntitled()) {
				view = 'active';
				announcement = 'Cinder Pro is active on this account.';
				return;
			}
			await new Promise((r) => setTimeout(r, GAP_MS));
		}
		view = 'slow';
		announcement = 'Your purchase has not arrived yet.';
	});
</script>

<svelte:head><title>Cinder Pro</title></svelte:head>

<main class="mx-auto w-full max-w-2xl px-5 py-12">
	<p aria-live="polite" class="sr-only">{announcement}</p>

	{#if view === 'waiting'}
		<h1 class="text-2xl font-semibold text-body">Confirming…</h1>
		<p class="mt-3 text-sm leading-relaxed text-mist">
			Stripe is telling Cinder the payment went through. This usually takes a second or two.
		</p>
	{:else if view === 'active'}
		<div in:fade={{ duration: dur(200) }}>
			<h1 class="text-2xl font-semibold text-body">Cinder Pro is active</h1>
			<p class="mt-3 text-sm leading-relaxed text-mist">
				Thank you. Larger transfers are available on this account now, and everything else about
				them is exactly what it was.
			</p>
			<p class="mt-6"><a class="btn btn-ember" href="/">Send something</a></p>
		</div>
	{:else}
		<div in:fade={{ duration: dur(200) }}>
			<h1 class="text-2xl font-semibold text-body">Not showing up yet</h1>
			<!-- Deliberately does NOT say the payment failed. This page cannot know
			     that, and telling someone who just paid that they did not is the
			     worse of the two wrong answers. -->
			<p class="mt-3 text-sm leading-relaxed text-mist">
				If Stripe charged you, the purchase will land shortly — reload this page or open your
				account and it will be there. If it still is not, Stripe's receipt email is the record of
				what happened, and it is the one Cinder does not have a copy of.
			</p>
			<p class="mt-6"><a class="btn btn-ghost" href="/account">Open your account</a></p>
		</div>
	{/if}
</main>
