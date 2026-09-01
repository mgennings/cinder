<script lang="ts">
	// THE SENDER'S VIEW OF A SENT VIDEO, and it is deliberately ignorant.
	//
	// Two words is the whole vocabulary: "still waiting" and "gone". No
	// timestamps, no watched-versus-declined, no counts — the server collapses
	// claimed, watched, declined, extended, expired, and destroyed into one
	// answer on purpose, so declining never carries a social penalty the sender
	// can measure. This surface renders that ignorance as the feature it is,
	// instead of looking broken.
	//
	// Presentational: the route owns every API call. /video/[locator] is the
	// only mount; the /v watch route redirects the creating browser here
	// (transferStatusToken answers whether this browser created it), so the
	// sender's whole vocabulary lives on one surface.
	import { fade } from 'svelte/transition';
	import { EXTENSION_SECONDS } from '$lib/video/types';
	import Button from '../atoms/Button.svelte';
	import QuietLink from '../atoms/QuietLink.svelte';
	import PulseDot from '../atoms/PulseDot.svelte';

	let {
		view,
		working,
		note,
		dur,
		ondestroy,
		onextend
	}: {
		/**
		 * 'checking'    — the status request is in flight.
		 * 'waiting'     — sealed, unclaimed, unexpired. Destroy is available.
		 * 'gone'        — everything else, indistinguishably. Add time is available.
		 * 'unavailable' — the status request failed; nothing is known either way.
		 * 'stranger'    — this browser holds no status credential for this video.
		 */
		view: 'checking' | 'waiting' | 'gone' | 'unavailable' | 'stranger';
		/** True while destroy or extend is in flight. */
		working: boolean;
		/** The outcome of the last action, already worded by the route. */
		note: string;
		dur: (ms: number) => number;
		ondestroy: () => void;
		onextend: () => void;
	} = $props();

	const extensionMinutes = EXTENSION_SECONDS / 60;

	// Focus lands on the outcome heading, not the top of the document — the
	// same rule every consequential surface in this app follows.
	let heading: HTMLElement | null = $state(null);
	$effect(() => {
		if (view !== 'checking') heading?.focus();
	});
</script>

{#if view === 'checking'}
	<p class="text-center text-sm text-mist" role="status">Checking on your video…</p>
{:else if view === 'waiting'}
	<div in:fade={{ duration: dur(300) }}>
		<h1
			bind:this={heading}
			tabindex="-1"
			class="mb-3 flex items-center gap-2 text-sm font-semibold text-ember-ink outline-none text-balance"
		>
			<PulseDot />
			Still waiting
		</h1>
		<p class="text-sm leading-relaxed text-body text-pretty">
			Your video is sealed, encrypted, and unclaimed. That is everything Cinder knows: no
			timestamps, no identities, no record of who holds the link.
		</p>
		<p class="mt-3 text-xs leading-relaxed text-mist text-pretty">
			The moment your person acts on it, this page will only ever say "gone". Whether they
			watched or declined stays theirs. That is the promise they were made too.
		</p>
		<Button variant="ghost" onclick={ondestroy} disabled={working} class="mt-5 w-full py-3 text-sm">
			Destroy it unwatched
		</Button>
		<p class="mt-2 text-center text-xs text-ghost">
			One tap, no confirmation, gone for good. Only works while nobody has opened it.
		</p>
	</div>
{:else if view === 'gone'}
	<div in:fade={{ duration: dur(300) }}>
		<h1
			bind:this={heading}
			tabindex="-1"
			class="mb-3 text-sm font-semibold text-ember-ink outline-none text-balance"
		>
			Gone
		</h1>
		<p class="text-sm leading-relaxed text-body text-pretty">
			Watched, declined, expired, or destroyed: Cinder cannot tell these apart, on purpose.
			A sender who could tell would make declining cost something, and it must cost nothing.
		</p>
		<p class="mt-3 text-xs leading-relaxed text-mist text-pretty">
			If a watch window is open right now, you can add {extensionMinutes} minutes to it from
			here. Cinder will say whether the time landed, and nothing else.
		</p>
		{#if note}
			<p in:fade={{ duration: dur(200) }} class="mt-3 text-xs leading-relaxed text-ember-ink text-pretty" role="status">
				{note}
			</p>
		{/if}
		<Button onclick={onextend} disabled={working} class="mt-5 w-full py-3 text-sm">
			Add {extensionMinutes} minutes
		</Button>
	</div>
{:else if view === 'unavailable'}
	<div in:fade={{ duration: dur(300) }}>
		<h1
			bind:this={heading}
			tabindex="-1"
			class="mb-3 text-sm font-semibold text-ember-ink outline-none text-balance"
		>
			Status is unavailable right now
		</h1>
		<p class="text-sm leading-relaxed text-body text-pretty">
			The status check could not reach Cinder. Nothing about your video has changed on
			Cinder's side; try again in a moment.
		</p>
	</div>
{:else}
	<div in:fade={{ duration: dur(300) }}>
		<h1
			bind:this={heading}
			tabindex="-1"
			class="mb-3 text-sm font-semibold text-ember-ink outline-none text-balance"
		>
			Nothing to show here
		</h1>
		<p class="text-sm leading-relaxed text-body text-pretty">
			Only the browser that created a video can check on it, and this one holds no record of
			creating this one. If you are the recipient, use the full link you were sent.
		</p>
	</div>
{/if}

<div class="mt-6 text-center">
	<QuietLink href="/" class="text-xs">Send something else</QuietLink>
</div>
