<script lang="ts">
	// The account surface. It has to do three things and resist doing a fourth:
	// sign in, say exactly what is stored, and delete it. There is no profile
	// here, no settings, no history, because none of those exist to show.
	import { onMount } from 'svelte';
	import {
		startSignIn,
		completeSignIn,
		signOut,
		deleteAccount,
		isEntitled,
		signedIn,
		identityConfigured
	} from '$lib/auth';

	type State = 'loading' | 'signed-out' | 'signed-in' | 'gone' | 'unavailable';

	let view = $state<State>('loading');
	let entitled = $state(false);
	let confirmingDelete = $state(false);
	// One live region for the whole page. Every state change writes a sentence
	// here, so a screen reader hears the outcome rather than inferring it from a
	// button that quietly changed label.
	let announcement = $state('');

	async function refresh() {
		entitled = await isEntitled();
		view = signedIn() ? 'signed-in' : 'signed-out';
		announcement = entitled
			? 'Signed in. Cinder Pro is active on this browser.'
			: view === 'signed-in'
				? 'Signed in. No purchase is recorded for this account.'
				: 'Signed out.';
	}

	onMount(async () => {
		if (!identityConfigured()) {
			view = 'unavailable';
			announcement = 'Accounts are not available in this build.';
			return;
		}

		// The OAuth callback lands on this same URL. Strip the code from the
		// address bar before anything else — it is single-use, but this product
		// does not leave credentials in browser history when it can help it.
		const code = new URLSearchParams(location.search).get('code');
		if (code) {
			history.replaceState(null, '', location.pathname);
			await completeSignIn(code);
		}
		await refresh();
	});

	async function handleSignOut() {
		announcement = 'Signing out.';
		await signOut();
		entitled = false;
		confirmingDelete = false;
		view = 'signed-out';
		announcement = 'Signed out. This browser no longer holds a token.';
	}

	async function handleDelete() {
		announcement = 'Deleting.';
		const done = await deleteAccount();
		// A failed delete must never read as a successful one. If the account is
		// still there, say so and leave the confirm step open.
		if (!done) {
			announcement = 'The account was not deleted. Nothing changed. Try again.';
			return;
		}
		view = 'gone';
		entitled = false;
		announcement = 'The account is deleted.';
	}

	// The complete list of what an account stores. If a line of code ever stores
	// something that is not on this list, this list is the defect.
	const stored = [
		{ label: 'From Apple or Google', value: 'An opaque account number' },
		{ label: 'Stored by Cinder', value: 'A one-way hash of that number' },
		{ label: 'Alongside it', value: 'Purchased: yes, and the date' },
		{ label: 'Email address', value: 'Not requested, not stored' },
		{ label: 'Name', value: 'Not requested, not stored' },
		{ label: 'Notes and files', value: 'Never linked to any of this' }
	];

	const truths = [
		{
			title: 'An account cannot be attached to a note',
			body: 'Notes and file transfers carry no account, no identifier, and no session — they never have and this does not change it. Sign-in runs against a different server, on a different address, with a separate log. There is no column to join.'
		},
		{
			title: 'We ask Apple for nothing but a number',
			body: 'Sign in with Apple usually offers to hide your address behind a private relay. Cinder asks for no name and no address at all, so there is not even a relay address to hold. Google is asked for the same: a subject identifier, nothing else.'
		},
		{
			title: 'The stored value is one-way',
			body: 'What lands in the database is a keyed hash of the account number, not the number. It cannot be reversed, and it cannot be matched against the same person on any other site that uses this sign-in, because each product hashes with its own key.'
		},
		{
			title: 'Deleting is real, and it is final',
			body: 'Delete removes the purchase record and then deletes the account itself at Apple and Google’s link, Cognito, and here. Nothing is disabled, archived, or flagged. Because no email is kept, there is no way to look you up afterward and no way to restore the purchase. That is the cost of storing nothing, and it is a real cost.'
		},
		{
			title: 'Signing out ends within five minutes',
			body: 'Signing out revokes this browser’s session immediately. The short-lived token already issued expires within five minutes and cannot be recalled before then — no system that hands out a signed token can honestly claim otherwise.'
		}
	];
</script>

<svelte:head>
	<title>Your Cinder account</title>
	<meta
		name="description"
		content="What a Cinder account stores, what it deliberately does not, and how to delete it."
	/>
</svelte:head>

<main class="mx-auto max-w-2xl px-5 py-16">
	<a href="/" class="text-2xl font-bold tracking-tight">Cinder<span class="text-ember">.</span></a>

	<h1 class="mt-8 text-2xl font-bold">An account, and nothing else</h1>
	<p class="mt-3 leading-relaxed text-mist">
		Sending a note or a file needs no account, and it never will. This exists for one reason: so a
		Cinder Pro purchase can be honored on the browser you are using now, and on the next one. It is
		the smallest thing that can do that job.
	</p>

	<!-- The announcement is the same information the buttons carry, said once,
	     for anyone who is not looking at the buttons. -->
	<p aria-live="polite" class="sr-only">{announcement}</p>

	<div class="card mt-8 p-5">
		{#if view === 'loading'}
			<p class="text-sm text-mist">Checking this browser…</p>
		{:else if view === 'unavailable'}
			<h2 class="font-semibold">Accounts are not available yet</h2>
			<p class="mt-2 text-sm leading-relaxed text-mist">
				Cinder Pro has not launched. Everything on the rest of this page describes what an account
				will store when it does.
			</p>
		{:else if view === 'gone'}
			<h2 class="font-semibold">The account is deleted</h2>
			<p class="mt-2 text-sm leading-relaxed text-mist">
				The purchase record and the account are both gone. Notes and transfers were never affected
				by either.
			</p>
			<a href="/" class="btn btn-ghost mt-4 px-4">Back to Cinder</a>
		{:else if view === 'signed-out'}
			<h2 class="font-semibold">Sign in</h2>
			<p class="mt-2 text-sm leading-relaxed text-mist">
				Either door stores the same thing: one opaque number. Apple’s asks for the least.
			</p>
			<div class="mt-4 flex flex-col gap-2 sm:flex-row">
				<button class="btn btn-ember px-5" onclick={() => startSignIn('SignInWithApple')}>
					Sign in with Apple
				</button>
				<button class="btn btn-ghost px-5" onclick={() => startSignIn('Google')}>
					Sign in with Google
				</button>
			</div>
		{:else}
			<h2 class="font-semibold">
				{entitled ? 'Cinder Pro is active' : 'Signed in'}
			</h2>
			<p class="mt-2 text-sm leading-relaxed text-mist">
				{entitled
					? 'This account holds a Cinder Pro purchase. Nothing else about you is here.'
					: 'No purchase is recorded for this account. Signing in on its own stores a hash and nothing more.'}
			</p>
			<div class="mt-4 flex flex-col gap-2 sm:flex-row">
				<!-- Signed in with nothing bought is otherwise a dead end: the page
				     states the absence of a purchase and offers no way to make one.
				     The link goes to the pay point, where the price and what Stripe
				     sees are both stated before any button exists to press. -->
				{#if !entitled}
					<a class="btn btn-ember px-5" href="/pro">Get Cinder Pro</a>
				{/if}
				<button class="btn btn-ghost px-5" onclick={handleSignOut}>Sign out</button>
				{#if confirmingDelete}
					<!-- A second, deliberate press rather than a browser confirm dialog:
					     the consequence is permanent and deserves a sentence, which a
					     native dialog cannot style or a screen reader read in context. -->
					<button class="btn btn-ember px-5" onclick={handleDelete}>
						Delete permanently
					</button>
					<button class="btn btn-ghost px-5" onclick={() => (confirmingDelete = false)}>
						Keep my account
					</button>
				{:else}
					<button class="btn btn-ghost px-5" onclick={() => (confirmingDelete = true)}>
						Delete my account
					</button>
				{/if}
			</div>
			{#if confirmingDelete}
				<p class="mt-3 text-sm leading-relaxed text-mist">
					This deletes the purchase record and the account itself. There is no email on file, so
					there is no way to restore it afterward.
				</p>
			{/if}
		{/if}
	</div>

	<h2 class="mt-10 text-lg font-semibold text-ember-ink">What an account stores</h2>
	<div class="record mt-4">
		{#each stored as row (row.label)}
			<div class="record-row">
				<span class="record-label">{row.label}</span>
				<span class="record-value">{row.value}</span>
			</div>
		{/each}
	</div>

	<h2 class="mt-10 text-lg font-semibold text-ember-ink">What that means</h2>
	<div class="mt-4 space-y-4">
		{#each truths as row (row.title)}
			<div class="card p-4">
				<h3 class="font-medium text-body">{row.title}</h3>
				<p class="mt-1 text-sm leading-relaxed text-mist">{row.body}</p>
			</div>
		{/each}
	</div>

	<p class="mt-10 text-sm text-mist">
		The rest of the threat model is on <a class="text-ember-ink underline" href="/security"
			>the security page</a
		>.
	</p>
</main>
