<script lang="ts">
	// THE JOURNEY PIECE. Two buttons and the four things that can go wrong
	// between pressing one and arriving at the provider.
	//
	// This exists because the same block was hand-rolled on /account and again
	// on /pro, and the two copies had already drifted: one said "Sign in with
	// Apple" and the other "Continue with Apple", one rendered a failure and the
	// other rendered nothing at all. A journey that is written twice is a
	// journey that is only debugged once.
	//
	// WHAT IT OWNS: the failure sentence, the offline refusal, the leaving
	// state, and where the person comes back to.
	// WHAT IT DOES NOT: any word about accounts, credits, or Cinder. The page
	// says those. That line is what makes this file copyable to the next
	// product without an edit.
	import { startSignIn, type Provider } from '$lib/auth';
	import ProviderButtons from './ProviderButtons.svelte';

	let {
		verb = 'Sign in',
		returnTo = null,
		error = '',
		onstatus
	}: {
		verb?: string;
		/** Same-origin path to land on afterward. Validated again inside startSignIn. */
		returnTo?: string | null;
		/** A failure carried over from a previous attempt, already worded. */
		error?: string;
		/** Every state change, as a sentence, for the page's one live region. */
		onstatus?: (sentence: string) => void;
	} = $props();

	// 'leaving' is not cosmetic. The redirect to Apple can take a visible moment
	// on a slow connection, and a button that does nothing for two seconds is a
	// button people press twice — which starts a second PKCE handshake and
	// throws away the verifier the first one is still waiting on.
	let leaving = $state(false);
	let offline = $state('');

	async function go(provider: Provider) {
		if (leaving) return;
		const name = provider === 'Google' ? 'Google' : 'Apple';

		// Asked before leaving rather than discovered after. navigator.onLine is
		// only trustworthy in the negative — false means there is definitely no
		// network — and the negative is the only thing being claimed here.
		if (!navigator.onLine) {
			offline = `This device is offline, so it cannot reach ${name}. Reconnect and try again — nothing was started.`;
			onstatus?.(offline);
			return;
		}

		offline = '';
		leaving = true;
		onstatus?.(`Continuing to ${name}.`);
		await startSignIn(provider, returnTo);
	}
</script>

{#if error}
	<!-- role=alert rather than the page's polite region: a failure that just
	     happened interrupts, and the polite region is already busy describing
	     the state the person can see. -->
	<p
		role="alert"
		class="mb-4 rounded-md border border-ember/40 bg-ember/5 px-4 py-3 text-sm leading-relaxed text-body"
	>
		{error}
	</p>
{/if}

{#if offline}
	<p
		role="alert"
		class="mb-4 rounded-md border border-line-strong bg-ink-raised px-4 py-3 text-sm leading-relaxed text-body"
	>
		{offline}
	</p>
{/if}

<ProviderButtons {verb} disabled={leaving} onchoose={go} />

{#if leaving}
	<p class="mt-3 text-sm text-mist">Handing you over…</p>
{/if}
