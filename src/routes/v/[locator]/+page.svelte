<script lang="ts">
	// THE WATCH ROUTE — the recipient's whole journey, for a person with no
	// account arriving from a text message. The route owns the store, the
	// clock, and the wiring; every surface belongs to a component and every
	// state to the store's discriminated union, so nothing here can render a
	// state that does not exist.
	//
	// Bot-safe by construction: nothing is fetched until a human presses a
	// button. The gate renders entirely from the link, so a link-preview bot
	// gets words — no claim, no window, no burn.
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import { fade } from 'svelte/transition';
	import { prefersReducedMotion } from 'svelte/motion';
	import { parseFragmentKey, parseFragmentParts } from '$lib/link';
	import { createWatchStore } from '$lib/video/watch';
	import { VideoExtensionUnfundedError } from '$lib/video/api';
	import { capabilityGrant, CAPABILITY_VIDEO_EXTEND } from '$lib/entitlement';
	import { transferStatusToken } from '$lib/status-store';
	import type { WatchSessionState } from '$lib/video/types';
	import Card from '$lib/ui/atoms/Card.svelte';
	import Button from '$lib/ui/atoms/Button.svelte';
	import Alert from '$lib/ui/atoms/Alert.svelte';
	import LiveRegion from '$lib/ui/atoms/LiveRegion.svelte';
	import Wordmark from '$lib/ui/atoms/Wordmark.svelte';
	import VaultPage from '$lib/ui/templates/VaultPage.svelte';
	import OutcomePanel from '$lib/ui/organisms/OutcomePanel.svelte';
	import VideoWatchGate from '$lib/ui/organisms/VideoWatchGate.svelte';
	import VideoWatchDownload from '$lib/ui/molecules/VideoWatchDownload.svelte';
	import VideoWatchEmber from '$lib/ui/molecules/VideoWatchEmber.svelte';
	import VideoWatchExtend from '$lib/ui/organisms/VideoWatchExtend.svelte';

	const locator = page.params.locator ?? '';
	// The fragment is read from the browser only — it never reached the server.
	const fragmentKey = parseFragmentKey(page.url.hash);
	const segmentsHint = parseFragmentParts(page.url.hash);

	// Created once; ssr=false so this runs only in the browser. Creating the
	// store touches no network — the gate stays bot-safe.
	const store = fragmentKey
		? createWatchStore({ locator, fragmentKey, segments: segmentsHint })
		: null;

	let view = $state<WatchSessionState>({ phase: 'gate', segments: segmentsHint });
	let announcement = $state('');
	let claimError = $state('');
	let extendBusy = $state(false);
	let noCredits = $state(false);
	// The verbatim finished copy says "8 more minutes" — true at the moment of
	// finishing, contradicted by the visible clock after an extension, so it
	// yields to the ember once time is added.
	let showFinishedCopy = $state(false);
	let headingEl: HTMLElement | null = $state(null);

	// The page's own clock, for RENDERING remaining time only. The deadline it
	// compares against is always the server's; the server's at-read guard is
	// the guarantee whether or not this interval ever fires. 512ms so the
	// displayed second never lags a real second.
	let nowEpoch = $state(Math.floor(Date.now() / 1000));

	const deadline = $derived(
		view.phase === 'downloading' ||
		view.phase === 'transfer-error' ||
		view.phase === 'watching' ||
		view.phase === 'countdown'
			? view.deadlineEpoch
			: 0
	);
	const remaining = $derived(deadline > 0 ? Math.max(0, deadline - nowEpoch) : 0);
	const clock = $derived(
		`${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')}`
	);

	// Svelte transitions are WAAPI animations no CSS rule can reach — reduced
	// motion is honored here, at their source.
	const dur = (ms: number) => (prefersReducedMotion.current ? 0 : ms);

	onMount(() => {
		// The creating browser holds a status credential for this locator, and a
		// sender revisiting their own link sees only "still waiting" or "gone"
		// (design doc, story 4) — that whole surface lives on /video/[locator],
		// so the sender is sent to their own door instead of the recipient's gate.
		if (transferStatusToken(locator)) {
			void goto(`/video/${locator}`, { replaceState: true });
			return;
		}

		const interval = setInterval(() => (nowEpoch = Math.floor(Date.now() / 1000)), 512);

		const unsubscribe = store?.subscribe((next) => {
			// Announcements ride the transitions, so a screen reader hears what
			// the screen shows — outcomes only, never every downloaded piece.
			if (next.phase !== view.phase) {
				if (next.phase === 'downloading' && view.phase === 'claiming') {
					announcement = 'Your watch window is open. The video is downloading.';
				} else if (next.phase === 'watching') {
					announcement = 'The whole video is here. Playback is ready.';
				} else if (next.phase === 'transfer-error') {
					announcement =
						"The video stopped arriving. Check your connection, then try again. Cinder's watch window keeps counting down on the server.";
				} else if (next.phase === 'countdown') {
					showFinishedCopy = true;
					announcement =
						'You watched all of it. Cinder keeps its copy for 8 more minutes, in case you want to see part of it again. Then it lets it go.';
				} else if (next.phase === 'gone') {
					announcement = next.watched
						? "That is the whole thing. Cinder's copy is destroyed, and this page has let go of its copy too. What you saw stays with you."
						: 'This video is no longer available.';
				} else if (next.phase === 'declined') {
					announcement = 'Destroyed unwatched. The sender only ever sees that it is gone.';
				}
			}
			view = next;
		});

		return () => {
			clearInterval(interval);
			unsubscribe?.();
			// The page letting go: best-effort local discard, never claimed as a
			// guarantee. The server's deadline needs no help from this tab.
			void store?.dispose();
		};
	});

	$effect(() => {
		if (view.phase === 'gone' || view.phase === 'declined') headingEl?.focus();
	});

	async function start() {
		if (!store) return;
		claimError = '';
		try {
			await store.claim();
		} catch {
			// The claim request got no answer. A window may or may not have
			// opened; a second claim resumes rather than double-opens, so trying
			// again is safe and the copy says so.
			claimError =
				"Couldn't reach Cinder. If a window did open, pressing Start watching resumes it rather than starting over.";
		}
	}

	async function declineIt() {
		if (!store) return;
		claimError = '';
		try {
			await store.decline();
		} catch {
			claimError = "Couldn't reach Cinder to decline. Nothing was played. Try again.";
		}
	}

	// Funding resolves prepaid-first, then a video.extend grant minted on the
	// identity API (1 credit, no subject — extending never identifies anyone).
	// A zero balance is a state with two open doors, never a checkout wall.
	async function addTime() {
		if (!store || view.phase !== 'countdown') return;
		extendBusy = true;
		noCredits = false;
		try {
			if (view.extensions.prepaidRemaining > 0) {
				await store.extend();
			} else {
				const grant = await capabilityGrant(CAPABILITY_VIDEO_EXTEND);
				if (!grant) {
					noCredits = true;
					return;
				}
				await store.extend(grant);
			}
			showFinishedCopy = false;
			announcement = 'Time added. The clock shows the new deadline.';
		} catch (error) {
			if (error instanceof VideoExtensionUnfundedError) {
				noCredits = true;
			}
			// The cap (403) already re-rendered the countdown with the door
			// closed, and gone (410) already moved the page on. Every minute
			// that was on the clock is untouched either way.
		} finally {
			extendBusy = false;
		}
	}
</script>

<svelte:head>
	<title>A video, for you alone · Cinder</title>
	<!-- Reader pages are noindex: they're ephemeral and carry a key in the fragment. -->
	<meta name="robots" content="noindex, nofollow" />
</svelte:head>

<!-- Outside every branch, so it survives the view change that has something to
     announce. Atomic, so the whole sentence is read rather than a diff. -->
<LiveRegion message={announcement} atomic />

<VaultPage>
	{#snippet header()}
		<Wordmark class="btn btn-ghost border-0 bg-transparent px-2 py-1" />
	{/snippet}

	<Card as="section" class="p-6">
		{#if !store}
			<OutcomePanel title="This link is missing its key" bind:heading={headingEl}>
				It may have been copied incompletely. Ask the person who sent it to share the whole link.
				{#snippet action()}
					<Button href="/" class="mt-6 px-5 py-3 text-sm">Go to Cinder</Button>
				{/snippet}
			</OutcomePanel>
		{:else if view.phase === 'gate' || view.phase === 'claiming'}
			{#if claimError}
				<Alert tone="boxed" class="mb-4">{claimError}</Alert>
			{/if}
			<VideoWatchGate busy={view.phase === 'claiming'} onstart={start} ondecline={declineIt} />
		{:else if view.phase === 'downloading'}
			<div in:fade={{ duration: dur(300) }}>
				<VideoWatchDownload received={view.received} segments={view.segments} />
				<p class="mt-4 text-center text-xs text-ghost">
					Watch window: <span class="tabular-nums">{clock}</span> left. Finishing the video starts a visible 8-minute countdown.
				</p>
			</div>
		{:else if view.phase === 'transfer-error'}
			<div in:fade={{ duration: dur(300) }} class="text-center">
				<h1 class="text-lg font-semibold text-balance">The video stopped arriving</h1>
				<Alert tone="boxed" class="mt-4 text-left">
					Check your connection, then try again. Cinder's watch window keeps counting down on the server.
				</Alert>
				<Button variant="ember" onclick={() => void store.retry()} class="mt-5">Try again</Button>
				<p class="mt-4 text-xs leading-relaxed text-ghost text-pretty">
					{view.received} of {view.segments} pieces are already here. If it keeps stopping, ask the sender for a new link.
				</p>
			</div>
		{:else if view.phase === 'watching'}
			<div in:fade={{ duration: dur(300) }}>
				<!-- Native element, so captions ride along if the file carries them.
				     nodownload keeps the controls honest with the gate's promise:
				     there is no download button. -->
				<!-- svelte-ignore a11y_media_has_caption -->
				<video
					src={view.objectUrl}
					controls
					playsinline
					controlslist="nodownload"
					class="w-full rounded-md bg-black"
					onended={() => store && void store.reportFinished()}
				></video>
				<p class="mt-4 text-center text-sm text-body">{view.meta.name}</p>
				<p class="mt-2 text-center text-xs text-ghost">
					Everything is local now: seek and rewatch freely. Your watch window: <span class="tabular-nums">{clock}</span> left.
				</p>
			</div>
		{:else if view.phase === 'countdown'}
			<div in:fade={{ duration: dur(300) }}>
				<!-- svelte-ignore a11y_media_has_caption -->
				<video
					src={view.objectUrl}
					controls
					playsinline
					controlslist="nodownload"
					class="w-full rounded-md bg-black"
					onended={() => store && void store.reportFinished()}
				></video>

				{#if showFinishedCopy}
					<p class="mt-4 text-sm leading-relaxed text-body text-pretty">
						You watched all of it. Cinder keeps its copy for 8 more minutes, in case you want to see part of it again. Then it lets it go.
					</p>
				{/if}

				<div class="mt-6">
					<VideoWatchEmber {remaining} />
				</div>

				<div class="mt-6">
					<VideoWatchExtend
						extensions={view.extensions}
						{remaining}
						busy={extendBusy}
						{noCredits}
						onextend={addTime}
					/>
				</div>
			</div>
		{:else if view.phase === 'gone'}
			<div in:fade={{ duration: dur(300) }}>
				{#if view.watched}
					<OutcomePanel title="That is the whole thing" bind:heading={headingEl}>
						Cinder's copy is destroyed, and this page has let go of its copy too. What you saw stays with you.
						{#snippet action()}
							<p class="mt-4 text-xs text-ghost text-pretty">
								If you need to see it again, ask the person who sent it for a new link.
							</p>
							<Button href="/" class="mt-6 px-5 py-3 text-sm">Send your own</Button>
						{/snippet}
					</OutcomePanel>
				{:else}
					<OutcomePanel title="This video is no longer available" bind:heading={headingEl}>
						Never existed, expired, destroyed, or its window ended: Cinder answers all of them the same way, on purpose.
						{#snippet action()}
							<Button href="/" class="mt-6 px-5 py-3 text-sm">Go to Cinder</Button>
						{/snippet}
					</OutcomePanel>
				{/if}
			</div>
		{:else if view.phase === 'declined'}
			<div in:fade={{ duration: dur(300) }}>
				<OutcomePanel title="Destroyed unwatched" bind:heading={headingEl}>
					The video is gone without having been played. The sender only ever sees that it is gone, never whether you watched or declined.
					{#snippet action()}
						<Button href="/" class="mt-6 px-5 py-3 text-sm">Go to Cinder</Button>
					{/snippet}
				</OutcomePanel>
			</div>
		{/if}
	</Card>
</VaultPage>
