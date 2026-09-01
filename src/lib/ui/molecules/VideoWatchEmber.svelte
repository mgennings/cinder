<script lang="ts">
	// THE ONE VISUAL SIGNATURE of the watch surface: an ember burning down.
	// Warm, never a bomb timer, and honest in mechanics — `remaining` is derived
	// by the route from the SERVER's deadline, and this component renders that
	// number without inventing, rounding, or theatricalizing anything.
	//
	// The time is carried three ways at once — a NUMERAL, a LABEL, and a SHAPE
	// (the depleting arc with its glowing tip) — never color alone. Under
	// prefers-reduced-motion the composed state still renders and the numbers
	// still count; only the tip's breathing and the arc's easing stop.
	import { FINISHED_COUNTDOWN_SECONDS } from '$lib/video/types';

	let {
		remaining,
		total = FINISHED_COUNTDOWN_SECONDS
	}: {
		/** Whole seconds until the server deadline. Never below zero. */
		remaining: number;
		/** The arc's denominator. Extensions can push remaining past it; the arc simply reads full. */
		total?: number;
	} = $props();

	// Geometry on the ladder: 128 viewBox, radius 56, stroke 8.
	const R = 56;
	const C = 2 * Math.PI * R;

	const fraction = $derived(Math.max(0, Math.min(1, remaining / total)));
	// The burning tip rides the leading edge of what is left: 12 o'clock when
	// full, receding clockwise as the ember burns down.
	const tip = $derived({
		x: 64 + R * Math.sin(2 * Math.PI * fraction),
		y: 64 - R * Math.cos(2 * Math.PI * fraction)
	});
	const minutes = $derived(Math.floor(remaining / 60));
	const seconds = $derived(String(remaining % 60).padStart(2, '0'));
</script>

<div
	class="ember-clock"
	role="timer"
	aria-label="{minutes} minutes {remaining % 60} seconds left on Cinder's copy"
>
	<svg viewBox="0 0 128 128" aria-hidden="true">
		<circle class="track" cx="64" cy="64" r={R} />
		<circle
			class="arc"
			cx="64"
			cy="64"
			r={R}
			transform="rotate(-90 64 64)"
			stroke-dasharray={C}
			stroke-dashoffset={C * (1 - fraction)}
		/>
		{#if fraction > 0}
			<circle class="tip" cx={tip.x} cy={tip.y} r="5" />
		{/if}
	</svg>
	<div class="readout">
		<span class="digits" data-testid="ember-digits">{minutes}:{seconds}</span>
		<span class="label">left on Cinder's copy</span>
	</div>
</div>

<style>
	.ember-clock {
		position: relative;
		width: 160px;
		margin-inline: auto;
	}

	svg {
		display: block;
		width: 100%;
	}

	.track {
		fill: none;
		stroke: var(--color-line);
		stroke-width: 8;
	}

	.arc {
		fill: none;
		stroke: var(--color-ember);
		stroke-width: 8;
		stroke-linecap: round;
		filter: drop-shadow(0 0 6px color-mix(in oklab, var(--color-ember) 55%, transparent));
		transition: stroke-dashoffset 1s linear;
	}

	.tip {
		/* --color-ember, not ember-soft: the tip is a meaningful graphic and
		   ember-soft measures 2.57:1 on the light card — under the 3:1 bar.
		   Ember measures 6.62:1 dark / 3.74:1 light (contrast.mjs, 2026-09-01). */
		fill: var(--color-ember);
		filter: drop-shadow(0 0 4px var(--color-ember));
		animation: breathe 2s ease-in-out infinite;
	}

	@keyframes breathe {
		0%,
		100% {
			opacity: 1;
		}
		50% {
			opacity: 0.6;
		}
	}

	.readout {
		position: absolute;
		inset: 0;
		display: grid;
		place-content: center;
		text-align: center;
		gap: 4px;
	}

	.digits {
		/* Tabular numerals so nothing reflows as seconds tick. */
		font-variant-numeric: tabular-nums;
		font-size: 1.5rem;
		font-weight: 600;
		color: var(--color-body);
		line-height: 1;
	}

	.label {
		font-size: 0.6875rem;
		line-height: 1.2;
		color: var(--color-mist);
		max-width: 88px;
		text-wrap: balance;
	}

	@media (prefers-reduced-motion: reduce) {
		.arc {
			transition: none;
		}
		.tip {
			animation: none;
		}
	}
</style>
