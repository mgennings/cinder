<script lang="ts">
	// THE SENDER'S STATUS ROUTE for a sent video. Reached from the link-ready
	// panel, and only useful in the browser that created the video: the status
	// credential lives in this browser's storage and nowhere else. A stranger
	// landing here learns nothing — not even whether the locator is real.
	//
	// The route owns every API call and every worded outcome; the organism
	// renders them. Same split as / and /f.
	import { page } from '$app/state';
	import { onMount } from 'svelte';
	import { prefersReducedMotion } from 'svelte/motion';
	import {
		checkVideoStatus,
		destroyVideo,
		extendVideo,
		VideoGoneError,
		VideoExtensionUnfundedError,
		VideoExtensionCapError
	} from '$lib/video/api';
	import { EXTENSION_SECONDS } from '$lib/video/types';
	import { transferStatusToken } from '$lib/status-store';
	import { capabilityGrant, CAPABILITY_VIDEO_EXTEND } from '$lib/entitlement';
	import Card from '$lib/ui/atoms/Card.svelte';
	import Wordmark from '$lib/ui/atoms/Wordmark.svelte';
	import LiveRegion from '$lib/ui/atoms/LiveRegion.svelte';
	import VaultPage from '$lib/ui/templates/VaultPage.svelte';
	import VideoSendStatus from '$lib/ui/organisms/VideoSendStatus.svelte';

	type ViewState = 'checking' | 'waiting' | 'gone' | 'unavailable' | 'stranger';

	const locator = $derived(page.params.locator ?? '');
	const extensionMinutes = EXTENSION_SECONDS / 60;

	let view: ViewState = $state('checking');
	let working = $state(false);
	let note = $state('');
	let announcement = $state('');
	let token: string | null = null;

	const dur = (ms: number) => (prefersReducedMotion.current ? 0 : ms);

	onMount(async () => {
		token = transferStatusToken(locator);
		if (!token) {
			view = 'stranger';
			return;
		}
		try {
			view = await checkVideoStatus(token);
		} catch {
			// Advisory only, and never fabricated: unreachable is not gone.
			view = 'unavailable';
		}
	});

	async function destroy() {
		if (!token || working) return;
		working = true;
		try {
			await destroyVideo({ statusToken: token });
			// 200 is unconditional — the endpoint is never an oracle. What is
			// true either way: no unclaimed video survives this tap.
			view = 'gone';
			note = 'If it was still waiting, it is destroyed unwatched now.';
			announcement = note;
		} catch {
			note = 'Cinder could not be reached. Nothing has changed; try again in a moment.';
			announcement = note;
		} finally {
			working = false;
		}
	}

	// Funding resolves the same way the server does: prepaid first (no grant
	// needed), then a fresh video.extend grant — minted only after the server
	// says the prepaid pool is empty, because a mint is a spend.
	async function addTime() {
		if (working) return;
		working = true;
		note = '';
		try {
			try {
				await extendVideo(locator);
			} catch (err) {
				if (!(err instanceof VideoExtensionUnfundedError)) throw err;
				const grant = await capabilityGrant(CAPABILITY_VIDEO_EXTEND, { fresh: true });
				if (!grant) {
					note = `Adding time costs 1 credit and this account has none Cinder can see. Any prepaid time you attached still works from their side.`;
					announcement = note;
					return;
				}
				await extendVideo(locator, grant);
			}
			note = `${extensionMinutes} minutes added to the open window.`;
			announcement = note;
		} catch (err) {
			if (err instanceof VideoGoneError) {
				note = 'There is no open watch window to add time to. Cinder cannot say more than that.';
			} else if (err instanceof VideoExtensionCapError) {
				note = 'This video has all the time it can be given.';
			} else {
				note = 'Cinder could not be reached. Nothing has changed; try again in a moment.';
			}
			announcement = note;
		} finally {
			working = false;
		}
	}
</script>

<svelte:head>
	<title>Your sent video · Cinder</title>
	<!-- Sender pages are noindex: ephemeral, and useless without local state. -->
	<meta name="robots" content="noindex, nofollow" />
</svelte:head>

<LiveRegion message={announcement} atomic />

<VaultPage>
	{#snippet header()}
		<Wordmark class="btn btn-ghost border-0 bg-transparent px-2 py-1" />
	{/snippet}

	<Card as="section" class="p-6">
		<VideoSendStatus
			{view}
			{working}
			{note}
			{dur}
			ondestroy={destroy}
			onextend={addTime}
		/>
	</Card>
</VaultPage>
