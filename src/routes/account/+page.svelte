<script lang="ts">
	// The account surface. It has to do three things and resist doing a fourth:
	// sign in, say exactly what is stored, and delete it. There is no profile
	// here, no settings, no history, because none of those exist to show.
	//
	// It is ALSO the OAuth callback, and that is not an accident of layout: the
	// Cognito app client's CallbackURLs list exactly `/account` on each domain
	// (template.yaml), so this is the one URL a provider is allowed to return to.
	// The doors at /signin and /signup send people out; this catches them and
	// forwards them on. Moving the callback anywhere else means editing that list
	// and redeploying the pool, and a mismatch between the two is a production
	// outage with an error page nobody can act on.
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import {
		completeSignIn,
		signOut,
		deleteAccount,
		entitlement,
		sessionState,
		identityConfigured,
		reviewAccessEnabled,
		takeReturnTo,
		peekReturnTo
	} from '$lib/auth';
	import SignInPanel from '$lib/ui/organisms/SignInPanel.svelte';
	import DashboardPage from '$lib/ui/templates/DashboardPage.svelte';
	import Card from '$lib/ui/atoms/Card.svelte';
	import Button from '$lib/ui/atoms/Button.svelte';
	import RuleHead from '$lib/ui/atoms/RuleHead.svelte';
	import LiveRegion from '$lib/ui/atoms/LiveRegion.svelte';
	import StoredDataTable from '$lib/ui/organisms/StoredDataTable.svelte';
	import TruthList from '$lib/ui/organisms/TruthList.svelte';
	import { PRO_PRICE, PRO_CREDITS, creditWord } from '$lib/pro';

	type State = 'loading' | 'signed-out' | 'signed-in' | 'expired' | 'gone' | 'unavailable';

	let view = $state<State>('loading');
	let credits = $state(0);
	let confirmingDelete = $state(false);
	// One live region for the whole page. Every state change writes a sentence
	// here, so a screen reader hears the outcome rather than inferring it from a
	// button that quietly changed label.
	let announcement = $state('');
	const reviewAccess = reviewAccessEnabled();

	async function refresh() {
		const session = await sessionState();
		if (session === 'live') {
			credits = (await entitlement()).credits;
			view = 'signed-in';
			announcement = reviewAccess
				? 'Review access is active. Development sends do not spend credits.'
				: credits
					? `Signed in. ${creditWord(credits)} left.`
					: 'Signed in. No credits on this account.';
			return;
		}
		credits = 0;
		// 'expired' is not 'signed-out'. Somebody whose session was revoked or ran
		// out was looking at a balance a moment ago, and showing them the ordinary
		// signed-out page makes that balance look like it was never there.
		view = session === 'expired' ? 'expired' : 'signed-out';
		announcement =
			session === 'expired' ? 'That session ended. Sign in again to see your balance.' : 'Signed out.';
	}

	// A failed sign-in is sent back to the door rather than handled here. The
	// person chose a door; the retry belongs on it, with whatever they were
	// heading toward still attached. /signin is the single retry surface because
	// the account attempt is identical either way, and it links to /signup.
	function backToDoor(reason: string, detail?: string) {
		const q = new URLSearchParams({ failed: reason });
		if (detail) q.set('detail', detail);
		const next = peekReturnTo();
		if (next) q.set('next', next);
		return goto(`/signin?${q}`, { replaceState: true });
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
		const params = new URLSearchParams(location.search);
		const code = params.get('code');
		// The provider can also refuse before a code is ever issued, and that
		// arrives as ?error= instead. Reading only `code` made a refusal look
		// exactly like an ordinary visit.
		const providerError = params.get('error_description') ?? params.get('error');

		if (code || providerError) {
			history.replaceState(null, '', location.pathname);
		}

		if (providerError) {
			// The provider's own words are not shown. Cognito forwards whatever
			// Apple or Google said, and that string is written for a developer, not
			// for the person who just pressed cancel.
			return backToDoor('rejected');
		}

		if (code) {
			const result = await completeSignIn(code);
			if (!result.ok) return backToDoor(result.reason, result.detail);

			// Signed in, and this is the moment the person gets sent where they were
			// actually going. Consumed here so a later reload of /account does not
			// bounce somebody who came back on purpose.
			const next = takeReturnTo();
			if (next) return goto(next, { replaceState: true });
		}

		await refresh();
	});

	async function handleSignOut() {
		announcement = 'Signing out.';
		await signOut();
		credits = 0;
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
		credits = 0;
		announcement = 'The account is deleted.';
	}

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
			title: 'The stored value cannot be reversed',
			body: 'What lands in the database is a keyed hash of the account number, not the number. It cannot be reversed, and it cannot be matched against the same person on any other site that uses this sign-in, because each product hashes with its own key.'
		},
		{
			title: 'Deleting is real, and it is final',
			body: 'Delete removes your remaining credits and then deletes the account itself at Apple and Google’s link, Cognito, and here. Nothing is disabled, archived, or flagged. Because no email is kept, there is no way to look you up afterward and no way to restore credits you had not spent. That is the cost of storing nothing, and it is a real cost.'
		},
		{
			title: 'Signing out ends within five minutes',
			body: 'Signing out revokes this browser’s session immediately. A signed token already issued remains valid until its five-minute window closes for good.'
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

<DashboardPage
	current="/account"
	location="Account"
	title="An account, and nothing else"
	lede={reviewAccess
		? 'This browser has a signed local review session. It can exercise paid paths without Stripe or a pretend credit balance.'
		: 'Sending a note or a file needs no account, and it never will. This account exists only to honor a Cinder Pro balance on the browser you are using now, and on the next one. Nothing else belongs here.'}
>
	<!-- The announcement is the same information the buttons carry, said once,
	     for anyone who is not looking at the buttons. -->
	<LiveRegion message={announcement} />

	<Card class="mt-8 p-5">
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
				Any remaining credits and the account are both gone. Notes and transfers were never affected
				by either.
			</p>
			<Button href="/" class="mt-4 px-4">Back to Cinder</Button>
		{:else if view === 'signed-out' || view === 'expired'}
			<h2 class="font-semibold">{view === 'expired' ? 'That session ended' : 'Sign in'}</h2>
			<p class="mt-2 mb-4 text-sm leading-relaxed text-mist">
				{#if view === 'expired'}
					The session on this browser was revoked or ran out. Nothing was lost and nothing was
					charged — signing in again brings the balance back.
				{:else}
					Either door stores the same thing: one opaque number. Apple asks for only that.
				{/if}
			</p>
			<!-- The same two buttons as /signin and /signup, from the same file. Three
			     hand-rolled copies of this block had already drifted into three
			     different labels and two different failure behaviors. -->
			<SignInPanel onstatus={(s) => (announcement = s)} />
		{:else}
			<h2 class="font-semibold">
				{reviewAccess ? 'Review access' : credits ? `${creditWord(credits)} left` : 'Signed in'}
			</h2>
			<!-- The balance is the whole reason this screen exists, so it is the
			     heading rather than a detail underneath one. A zero balance says
			     what still works before it says what to do about it: running out
			     is the expected end of a purchase, not a broken product. -->
			<p class="mt-2 text-sm leading-relaxed text-mist">
				{reviewAccess
					? 'This is a signed development session, not a purchased balance. It mints server-verified capabilities without spending credits, so the video path can be tested end to end.'
					: credits
						? `One credit sends one large file. That count and the date you last bought are the only things here besides a hash.`
						: `No credits on this account. Sending under the free size limit still works, free, forever — ${PRO_PRICE} adds ${PRO_CREDITS} large sends when you want them.`}
			</p>
			<div class="mt-4 flex flex-col gap-2 sm:flex-row">
				{#if reviewAccess}
					<Button variant="ember" href="/?mode=video" class="px-5">Send a video</Button>
				{:else}
				<!-- Signed in with nothing bought is otherwise a dead end: the page
				     states the absence of a purchase and offers no way to make one.
				     The link goes to the pay point, where the price and what Stripe
				     sees are both stated before any button exists to press. -->
				<!-- Always offered, never only at zero: a top-up is the model, and
				     someone with two credits left who is about to send five files
				     needs the button before they run out, not after. -->
				<Button variant="ember" href="/pro" class="px-5">
					{credits ? 'Add more credits' : 'Get Cinder Pro'}
				</Button>
				{/if}
				<Button class="px-5" onclick={handleSignOut}>Sign out</Button>
				{#if !reviewAccess && confirmingDelete}
					<!-- A second, deliberate press rather than a browser confirm dialog:
					     the consequence is permanent and deserves a sentence, which a
					     native dialog cannot style or a screen reader read in context. -->
					<Button variant="ember" class="px-5" onclick={handleDelete}>
						Delete permanently
					</Button>
					<Button class="px-5" onclick={() => (confirmingDelete = false)}>
						Keep my account
					</Button>
				{:else if !reviewAccess}
					<Button class="px-5" onclick={() => (confirmingDelete = true)}>
						Delete my account
					</Button>
				{/if}
			</div>
			{#if !reviewAccess && confirmingDelete}
				<p class="mt-3 text-sm leading-relaxed text-mist">
					This deletes any credits you have left and the account itself. There is no email on file, so
					there is no way to restore it afterward.
				</p>
			{/if}
		{/if}
	</Card>

	<RuleHead class="mt-10">What an account stores</RuleHead>
	<StoredDataTable />

	<TruthList title="What that means" rows={truths} />

	<p class="mt-10 text-sm text-mist">
		The rest of the threat model is on <a class="text-ember-ink underline" href={resolve('/security')}
			>the security page</a
		>.
	</p>
</DashboardPage>
