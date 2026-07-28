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
		content="Creating a Cinder account asks for no email, no password, and no name. Apple or Google hand over one opaque number and that is the whole account."
	/>
	<meta name="robots" content="noindex" />
</svelte:head>

<AuthDoor
	title="Create an account"
	lede="There is no form. Apple or Google hand Cinder one opaque number, Cinder stores a one-way hash of it, and that is the entire account."
	verb="Sign up"
>
	{#snippet note()}
		<p>
			What Cinder never asks for: an email address, a name, a password, a phone number. Not hidden
			behind a relay, not optional — never requested at all. The whole record is a hash, a count of
			sends remaining, and the date of the last purchase.
		</p>
		<p class="mt-3">
			The cost of storing nothing is real and worth knowing now: there is no way to look you up
			afterward, so a lost account cannot be recovered and unspent credits cannot be moved to a new
			one. <a class="text-ember-ink underline" href="/account">The full list is on the account page.</a>
		</p>
	{/snippet}
	{#snippet otherDoor()}
		Already used Apple or Google here? <a class="text-ember-ink underline" href="/signin"
			>Sign in instead.</a
		>
	{/snippet}
</AuthDoor>
