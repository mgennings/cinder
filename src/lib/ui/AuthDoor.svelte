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
			// SvelteKit's own replaceState, not the browser's: the raw one desyncs
			// the router's idea of the URL from the address bar and SvelteKit warns
			// about exactly this in dev.
			replaceState(clean.pathname + clean.search, {});
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

<main class="bench mx-auto flex min-h-dvh max-w-md flex-col justify-center px-5 py-16">
	<a href="/" class="text-2xl font-bold tracking-tight">Cinder<span class="text-ember">.</span></a>

	<p aria-live="polite" class="sr-only">{announcement}</p>

	<div class="card mt-8 p-6">
		{#if view === 'loading'}
			<p class="text-sm text-mist">Checking this browser…</p>
		{:else if view === 'unavailable'}
			<h1 class="text-xl font-semibold">Accounts are not available yet</h1>
			<p class="mt-2 text-sm leading-relaxed text-mist">
				Cinder Pro has not launched here. Sending under the free size limit works exactly as it
				always has, with no account at all.
			</p>
			<a href="/" class="btn btn-ghost mt-5 px-4">Back to Cinder</a>
		{:else if view === 'signed-in'}
			<h1 class="text-xl font-semibold">You are already signed in</h1>
			<p class="mt-2 text-sm leading-relaxed text-mist">
				Nothing to do here. This browser already holds a session.
			</p>
			<div class="mt-5 flex flex-col gap-2 sm:flex-row">
				<a class="btn btn-ember px-5" href={next ?? '/account'}>Continue</a>
				{#if next}
					<a class="btn btn-ghost px-5" href="/account">Your account</a>
				{/if}
			</div>
		{:else}
			<h1 class="text-xl font-semibold">{title}</h1>
			<p class="mt-2 mb-5 text-sm leading-relaxed text-mist">
				{#if view === 'expired'}
					That session ended — it was revoked, or it simply ran out. Nothing was lost and nothing
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
	</div>

	{#if view === 'ready' || view === 'expired'}
		<p class="mt-6 text-center text-sm text-mist">
			{@render otherDoor()}
		</p>
	{/if}

	<p class="mt-6 text-center text-xs leading-relaxed text-ghost">
		Sending a note or a file needs no account and never will. An account exists only so a Cinder
		Pro balance survives a closed tab.
	</p>
</main>
