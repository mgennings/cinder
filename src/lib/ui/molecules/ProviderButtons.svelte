<script lang="ts">
	// THE TWO DOORS. This is the piece a second product copies unchanged.
	//
	// It holds only the labels Apple and Google require plus the browser-local
	// selection cue. It makes no decision about what happens after — it hands
	// the provider back and the page decides. That is the seam: everything
	// Cinder-specific about signing in lives in the page, and everything
	// brand-specific about the buttons lives here.
	//
	// The marks are inlined rather than served from /static. A remote <img> for
	// a logo means a request that can fail, a flash of an unstyled button, and a
	// second thing to keep in sync with the CSS that colors it. These two paths
	// are the published marks and they do not change.
	import type { Provider } from '$lib/auth';

	let {
		verb = 'Sign in',
		disabled = false,
		lastUsed = null,
		onchoose
	}: {
		/** "Sign in" or "Sign up" — the only word that differs between the doors. */
		verb?: string;
		disabled?: boolean;
		/** A browser-local selection cue. It never means authentication succeeded. */
		lastUsed?: Provider | null;
		onchoose: (provider: Provider) => void;
	} = $props();
</script>

<!-- Apple first, and it is first for a reason that is written down: Apple's
     guidelines require its button not be visually subordinate to another
     provider's. Same width, same height, same weight, and above. -->
<div class="provider-stack">
	<div class="provider-choice" data-provider="SignInWithApple">
		{#if lastUsed === 'SignInWithApple'}
			<span class="provider-last-used">Last used<span class="sr-only"> in this browser</span></span>
		{/if}
		<button
			type="button"
			class="btn btn-provider btn-apple"
			{disabled}
			onclick={() => onchoose('SignInWithApple')}
		>
		<!-- aria-hidden: the label already says Apple, so an alt text here would
		     make a screen reader announce the word twice. -->
		<svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true">
			<path
				d="M17.9954 12.6879C18.0263 16.0172 20.915 17.1251 20.947 17.1393C20.9225 17.2173 20.4854 18.7181 19.4251 20.2682C18.5084 21.6085 17.5571 22.9437 16.0585 22.9714C14.586 22.9985 14.1124 22.0979 12.4289 22.0979C10.7459 22.0979 10.2198 22.9437 8.82587 22.9985C7.37932 23.0533 6.27775 21.5493 5.35356 20.214C3.465 17.4827 2.02175 12.4959 3.95967 9.12967C4.92239 7.45801 6.64284 6.39944 8.51023 6.3723C9.9307 6.34519 11.2714 7.3283 12.1398 7.3283C13.0077 7.3283 14.6369 6.14603 16.3498 6.31966C17.0668 6.34952 19.0796 6.60941 20.372 8.50192C20.2679 8.56651 17.9704 9.90449 17.9954 12.6879ZM15.2279 4.51263C15.9959 3.58268 16.5128 2.2881 16.3717 1C15.2648 1.04451 13.9262 1.73794 13.1321 2.66738C12.4205 3.49044 11.7974 4.8078 11.9655 6.07041C13.1994 6.16591 14.4599 5.44317 15.2279 4.51263Z"
				fill="currentColor"
			/>
			</svg>
			<span class="provider-label">
				<span>{verb} with</span>
				<span>Apple</span>
			</span>
		</button>
	</div>

	<div class="provider-choice" data-provider="Google">
		{#if lastUsed === 'Google'}
			<span class="provider-last-used">Last used<span class="sr-only"> in this browser</span></span>
		{/if}
		<button
			type="button"
			class="btn btn-provider btn-google"
			{disabled}
			onclick={() => onchoose('Google')}
		>
		<!-- The G is full color always. It is never tinted with currentColor,
		     never outlined, and never dimmed, including on the disabled state. -->
		<svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
			<path
				d="M24 12.27C24 11.48 23.9284 10.73 23.8058 9.99998H12.2605V14.51H18.871C18.5747 15.99 17.7062 17.24 16.4189 18.09V21.09H20.3627C22.6717 19 24 15.92 24 12.27Z"
				fill="#4285F4"
			/>
			<path
				d="M12.2606 24C15.571 24 18.3398 22.92 20.3628 21.09L16.419 18.09C15.3156 18.81 13.9158 19.25 12.2606 19.25C9.06269 19.25 6.35515 17.14 5.38453 14.29H1.31812V17.38C3.33089 21.3 7.46882 24 12.2606 24Z"
				fill="#34A853"
			/>
			<path
				d="M5.38442 14.2901C5.12899 13.5701 4.99617 12.8001 4.99617 12.0001C4.99617 11.2001 5.13921 10.4301 5.38442 9.71009V6.62009H1.31801C0.480203 8.24009 0 10.0601 0 12.0001C0 13.9401 0.480203 15.7601 1.31801 17.3801L5.38442 14.2901Z"
				fill="#FBBC05"
			/>
			<path
				d="M12.2606 4.74998C14.0691 4.74998 15.6834 5.35999 16.9605 6.54999L20.4548 3.12999C18.3398 1.18999 15.571 -1.52588e-05 12.2606 -1.52588e-05C7.46882 -1.52588e-05 3.33089 2.69999 1.31812 6.61999L5.38453 9.70999C6.35515 6.85999 9.06269 4.74998 12.2606 4.74998Z"
				fill="#EA4335"
			/>
			</svg>
			<span class="provider-label">
				<span>{verb} with</span>
				<span>Google</span>
			</span>
		</button>
	</div>
</div>

<style>
	.provider-stack {
		display: grid;
		gap: 0.75rem;
	}

	.provider-choice {
		position: relative;
		display: grid;
		min-width: 0;
	}

	.provider-last-used {
		z-index: 1;
		justify-self: end;
		margin: 0 0.75rem -0.5rem 0;
		border: 1px solid var(--color-ember);
		border-radius: 999px;
		background: var(--color-ink-raised);
		padding: 0.125rem 0.5rem;
		color: var(--color-body);
		font-family: var(--font-mono);
		font-size: 0.6875rem;
		font-weight: 700;
		line-height: 1.4;
		letter-spacing: 0.06em;
		text-transform: uppercase;
	}

	.provider-label {
		display: flex;
		flex-wrap: wrap;
		justify-content: center;
		gap: 0 0.25em;
	}

	.provider-label > span {
		white-space: nowrap;
	}
</style>
