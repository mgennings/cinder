<script lang="ts">
	// The same two buttons as /signin, and saying so out loud is the point of
	// this page existing. Every other product trains people to expect a longer
	// form on the sign-up side; here there is nothing extra to fill in, and
	// somebody who does not know that will hunt for the form.
	import AuthDoor from '$lib/ui/organisms/AuthDoor.svelte';
</script>

<svelte:head>
	<title>Create a Cinder account</title>
	<meta
		name="description"
		content="Create a Cinder account with Apple or Google. Cinder keeps only the account data needed to sign you in and carry your Pro balance."
	/>
	<meta name="robots" content="noindex" />
</svelte:head>

<AuthDoor
	title="Sign up"
	lede="There is no form. Choose Apple or Google, and Cinder creates the smallest account needed to sign you in and keep your Cinder Pro balance with you."
	verb="Sign up"
>
	{#snippet note()}
		<p>
			Account data is used only to sign you in and keep your balance. Cinder does not use it for
			tracking or sell it, and notes and transfers never carry the account.
		</p>
		<p class="mt-3">
			Choose a provider you expect to keep using. Account recovery is limited today, and unspent
			credits cannot be moved to a new account. <a class="text-ember-ink underline" href="/account"
				>The full account record is listed&nbsp;here.</a
			>
		</p>
	{/snippet}
	{#snippet otherDoor()}
		Already used Apple or Google here? <a class="text-ember-ink underline" href="/signin"
			>Sign in&nbsp;instead.</a
		>
	{/snippet}
</AuthDoor>
