<script lang="ts">
	import AuthDoor from '$lib/ui/AuthDoor.svelte';
</script>

<svelte:head>
	<title>Sign in to Cinder</title>
	<meta
		name="description"
		content="Sign in to Cinder with Apple or Google. No email address, no password, no profile."
	/>
	<!-- Neither door should ever be a search result. They are steps in a journey,
	     not pages with something to say, and an indexed sign-in URL is how people
	     arrive at one out of context. -->
	<meta name="robots" content="noindex" />
</svelte:head>

<AuthDoor
	title="Sign in"
	lede="Either door hands Cinder one opaque number and nothing else. There is no password here to remember or to lose, because there is none to store."
	verb="Sign in"
>
	{#snippet note()}
		Whichever one you used the first time is the one that finds your credits. They are separate
		accounts, and Cinder cannot tell that they belong to the same person — which is the same
		property that keeps anyone else from telling.
	{/snippet}
	{#snippet otherDoor()}
		Never signed in before? <a class="text-ember-ink underline" href="/signup"
			>Making an account is the same two buttons.</a
		>
	{/snippet}
</AuthDoor>
