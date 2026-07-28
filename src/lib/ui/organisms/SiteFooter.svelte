<script lang="ts">
	// THE QUIETEST THING ON THE PAGE, and deliberately so.
	//
	// Sending needs no account and never will, so the way in to one must not read
	// as a signup prompt on a product whose whole argument is that it does not
	// know who you are. But someone who HAS paid needs a way back to their
	// balance, and until this existed there was none: /account was reachable only
	// from one sentence inside /security.
	import { signedIn, identityConfigured } from '$lib/auth';
	import { creditWord } from '$lib/pro';
	import QuietLink from '../atoms/QuietLink.svelte';

	let {
		credits
	}: {
		/** null means "we have no idea" — signed out, or a build with no identity API. */
		credits: number | null;
	} = $props();
</script>

<footer class="mt-8 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-center text-xs">
	<QuietLink href="/security">How private is this, really?</QuietLink>
	<QuietLink href="/field-notes">Field notes</QuietLink>
	{#if identityConfigured()}
		<QuietLink href={signedIn() ? '/account' : '/pro'}>
			{#if credits !== null}
				{creditWord(credits)}
			{:else if signedIn()}
				Your account
			{:else}
				Cinder Pro
			{/if}
		</QuietLink>
	{/if}
</footer>
