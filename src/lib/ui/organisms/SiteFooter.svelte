<script lang="ts">
	// THE QUIETEST THING ON THE PAGE, and deliberately so.
	//
	// Sending needs no account and never will. Sign-in is still a real destination
	// for video and paid sends, so name it plainly instead of making Cinder Pro do
	// double duty as both the account door and the price page.
	import { signedIn, identityConfigured } from '$lib/auth';
	import { creditWord } from '$lib/pro';
	import QuietLink from '../atoms/QuietLink.svelte';

	let {
		credits,
		reviewAccess = false
	}: {
		/** null means "we have no idea" — signed out, or a build with no identity API. */
		credits: number | null;
		/** Local review authority is not a purchased balance. */
		reviewAccess?: boolean;
	} = $props();
</script>

<footer class="mt-8 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-center text-xs">
	<QuietLink href="/security">How private is this, really?</QuietLink>
	<QuietLink href="/field-notes">Field notes</QuietLink>
	{#if identityConfigured()}
		<QuietLink href={signedIn() ? '/account' : '/signin'}>
			{#if reviewAccess}
				Review access
			{:else if credits !== null}
				{creditWord(credits)}
			{:else if signedIn()}
				Your account
			{:else}
				Sign in
			{/if}
		</QuietLink>
	{/if}
</footer>
