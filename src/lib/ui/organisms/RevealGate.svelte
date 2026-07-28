<script lang="ts">
	// THE GATE. The last screen before something is destroyed, and the only
	// screen in Cinder whose job is to make sure a person knows the cost of the
	// button before they press it.
	//
	// It claims nothing, decrypts nothing, and holds no ciphertext. It renders
	// the warning that matches the state the route is in and calls back. That
	// separation is deliberate: the words here are the product's promise written
	// down, and they must be readable without running a delivery.
	import { fade } from 'svelte/transition';
	import Button from '../atoms/Button.svelte';
	import Alert from '../atoms/Alert.svelte';
	import TextInput from '../atoms/TextInput.svelte';
	import PulseDot from '../atoms/PulseDot.svelte';

	let {
		partCount,
		needsPassphrase,
		passphrase = $bindable(''),
		passphraseElement = $bindable(null),
		errorMsg,
		busy,
		status,
		dur,
		onreveal
	}: {
		/** 1 for a single file. Above 1, every warning changes. */
		partCount: number;
		needsPassphrase: boolean;
		passphrase?: string;
		/** The route focuses this itself, at the moment the claim has already happened. */
		passphraseElement?: HTMLInputElement | null;
		errorMsg: string;
		busy: boolean;
		status: string;
		dur: (ms: number) => number;
		onreveal: () => void;
	} = $props();

	const chunked = $derived(partCount > 1);
</script>

<div>
	<h1 class="text-center text-lg font-semibold">Someone left you a one-time file</h1>

	{#if needsPassphrase}
		<!-- The claim already happened. The pre-claim warning below is now
		     false — "can begin" describes something that has begun — so it
		     is replaced rather than left standing next to a passphrase box. -->
		<p in:fade={{ duration: dur(200) }} class="mt-3 text-sm leading-relaxed text-mist">
			{#if chunked}
				Cinder has already destroyed the first of {partCount} pieces. That piece is held only
				in this tab, and the rest will not be claimed until the passphrase opens it. If you
				reload or close this page, the file is permanently unavailable.
			{:else}
				Cinder's stored copy is already deleted. The encrypted file is held only in this tab,
				and it needs its passphrase to open. If you reload or close this page before it
				saves, it is permanently unavailable.
			{/if}
		</p>

		<div in:fade={{ duration: dur(200) }} class="mt-5">
			<label for="pass" class="mb-2 block text-sm text-mist">Passphrase</label>
			<TextInput
				id="pass"
				bind:element={passphraseElement}
				type="password"
				autocomplete="off"
				bind:value={passphrase}
				onkeydown={(e) => e.key === 'Enter' && onreveal()}
				placeholder="Enter the passphrase"
			/>
			{#if errorMsg}
				<Alert class="mt-2">{errorMsg}</Alert>
			{/if}
		</div>
	{:else}
		<!-- The approved warning. Every clause here is enforced by the
		     backend; none of it is softened to make the button easier to
		     press. The chunked version says the extra cost out loud BEFORE
		     the button, because a file delivered in pieces can fail partway
		     and nobody should learn that halfway through. -->
		<p id="reveal-warning" class="mt-3 text-sm leading-relaxed text-mist">
			{#if chunked}
				This file arrives in {partCount} pieces. Cinder deletes each stored piece before it
				releases that piece's bytes, one at a time. If any piece fails, every piece already
				delivered is permanently destroyed and the file cannot be assembled — there is no
				retry and no resume. Keep this tab open until it saves. Copies saved by the sender,
				recipient, browser, operating system, or another service remain outside Cinder's
				control.
			{:else}
				Exactly one server delivery can begin. Cinder deletes its encrypted stored copy before
				releasing bytes. If that delivery fails, the file is permanently unavailable. Copies
				saved by the sender, recipient, browser, operating system, or another service remain
				outside Cinder's control.
			{/if}
		</p>
	{/if}

	<Button
		variant="ember"
		id="reveal"
		onclick={onreveal}
		disabled={busy}
		aria-describedby={needsPassphrase ? undefined : 'reveal-warning'}
		class="mt-6 w-full py-3 text-sm"
	>
		{#if busy}
			<PulseDot class="bg-black/70" />
			{status || 'Working…'}
		{:else if needsPassphrase}
			Unlock and save
		{:else if chunked}
			Reveal and destroy all {partCount} stored pieces
		{:else}
			Reveal and destroy Cinder's stored copy
		{/if}
	</Button>
</div>
