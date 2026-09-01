<script lang="ts">
	import AuthDoor from '$lib/ui/organisms/AuthDoor.svelte';
</script>

<svelte:head>
	<title>Sign in to Cinder</title>
	<meta
		name="description"
		content="Sign in to Cinder with Apple or Google. Cinder keeps only the account data needed to sign you in and carry your Pro balance."
	/>
	<!-- Neither door should ever be a search result. They are steps in a journey,
	     not pages with something to say, and an indexed sign-in URL is how people
	     arrive at one out of context. -->
	<meta name="robots" content="noindex" />
</svelte:head>

<AuthDoor
	title="Sign in"
	lede="Choose Apple or Google. Cinder keeps only the account data needed to sign you in and carry your Cinder Pro&nbsp;balance."
	verb="Sign in"
>
	{#snippet note()}
		<p>
			Choose the provider tied to the account you used before. “Last used” means this browser
			selected that button last. It does not mean the sign-in&nbsp;finished.
		</p>
		<p class="mt-3">
			Cinder does not use account data to track you or sell it. Notes and transfers never carry
			the account.
		</p>
	{/snippet}
	{#snippet otherDoor()}
		Never signed in before? <a class="text-ember-ink underline" href="/signup"
			>Making an account is the same two buttons.</a
		>
	{/snippet}
</AuthDoor>
