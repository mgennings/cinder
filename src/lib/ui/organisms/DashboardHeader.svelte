<script lang="ts">
	import Button from '../atoms/Button.svelte';
	import Wordmark from '../atoms/Wordmark.svelte';

	let { current, location }: { current: string; location: string } = $props();

	const destinations = [
		{ href: '/', label: 'Send' },
		{ href: '/pro', label: 'Cinder Pro' },
		{ href: '/account', label: 'Account' }
	];
</script>

<header class="dashboard-header">
	<a class="skip-link dashboard-skip" href="#main-content">Skip to content</a>
	<div class="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-x-6 gap-y-2 px-5 py-2">
		<div class="flex min-w-0 items-center gap-3">
			<Wordmark mark class="shrink-0" />
			<span class="dashboard-location-rule h-5 w-px shrink-0 bg-line-strong" aria-hidden="true"></span>
			<span class="dashboard-location util truncate">{location}</span>
		</div>

		<nav class="dashboard-nav" aria-label="Cinder destinations">
			{#each destinations as destination (destination.href)}
				<Button
					variant="bare"
					href={destination.href}
					class="dashboard-nav-link"
					aria-current={current === destination.href ? 'page' : undefined}
				>
					{destination.label}
				</Button>
			{/each}
		</nav>
	</div>
</header>

<style>
	.dashboard-header {
		position: sticky;
		inset-block-start: 0;
		z-index: 30;
		border-bottom: 1px solid var(--color-line);
		background: color-mix(in oklab, var(--color-ink) 94%, transparent);
		backdrop-filter: blur(1rem) saturate(1.2);
	}

	.dashboard-skip {
		position: fixed;
		inset-block-start: 0.5rem;
		inset-inline-start: 0.5rem;
		z-index: 40;
		display: inline-flex;
		min-height: 2.75rem;
		align-items: center;
		border-radius: var(--radius-field);
		background: var(--color-ink-raised);
		padding-inline: 1rem;
		color: var(--color-body);
		box-shadow: var(--focus-ring);
		transform: translateY(-150%);
	}

	.dashboard-skip:focus {
		transform: translateY(0);
	}

	.dashboard-nav {
		display: flex;
		flex-wrap: wrap;
		justify-content: flex-end;
		gap: 0.25rem;
	}

	.dashboard-nav :global(.dashboard-nav-link) {
		position: relative;
		padding-inline: 0.75rem;
		color: var(--color-mist);
		text-wrap: balance;
	}

	.dashboard-nav :global(.dashboard-nav-link:hover) {
		background: var(--color-ink-raised);
		color: var(--color-body);
	}

	.dashboard-nav :global(.dashboard-nav-link[aria-current='page']) {
		background: var(--color-ink-raised);
		color: var(--color-body);
		font-weight: 700;
		text-decoration: underline;
		text-decoration-color: var(--color-ember);
		text-decoration-thickness: 2px;
		text-underline-offset: 0.5rem;
	}

	@media (max-width: 40rem) {
		.dashboard-location,
		.dashboard-location-rule {
			display: none;
		}

		.dashboard-nav {
			display: grid;
			grid-template-columns: 1fr 2fr 2fr;
			width: 100%;
		}

		.dashboard-nav :global(.dashboard-nav-link) {
			padding-inline: 0.25rem;
			font-size: 0.8125rem;
			text-align: center;
		}
	}

	@media (forced-colors: active) {
		.dashboard-header,
		.dashboard-skip,
		.dashboard-nav :global(.dashboard-nav-link[aria-current='page']) {
			background: Canvas;
			color: CanvasText;
		}

		.dashboard-nav :global(.dashboard-nav-link[aria-current='page']) {
			border-block-end: 2px solid CanvasText;
		}
	}
</style>
