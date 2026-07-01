<script lang="ts">
	// An ambient star-tetrahedron — the 2D silhouette of a merkaba: two
	// interlocked, counter-rotating tetrahedra. It's not decoration: the merkaba
	// is two fields that only work as one, which is exactly Cinder's two-factor
	// model (link key + passphrase). It sits quietly behind the card and breathes.
	//
	// A rewrite of Matt's Three.js merkaba as pure CSS — no WebGL, no bundle cost.
	// Motion honors the apple-transitions rules: linear infinite spin with a GPU
	// hint (no seam stutter), ember-toned, and stilled under reduced-motion.

	let { size = 320 }: { size?: number } = $props();
</script>

<div class="merkaba" style="--m-size:{size}px" aria-hidden="true">
	<span class="tri up"></span>
	<span class="tri down"></span>
	<span class="halo"></span>
</div>

<style>
	.merkaba {
		position: absolute;
		top: 50%;
		left: 50%;
		width: var(--m-size);
		height: var(--m-size);
		transform: translate(-50%, -50%);
		pointer-events: none;
		opacity: 0.16;
		transform-style: preserve-3d;
	}

	/* Two triangles, one up, one down → the Star-of-David projection of the
	   merkaba. Each counter-rotates on its own GPU layer. */
	.tri {
		position: absolute;
		inset: 0;
		translate: 0 0; /* create a paint layer without touching transform */
		transform: translateZ(0);
	}

	/* Outer filled triangle. */
	.tri::before {
		content: '';
		position: absolute;
		inset: 10%;
		background: linear-gradient(135deg, var(--color-ember), var(--color-ember-soft));
		clip-path: polygon(50% 0%, 100% 100%, 0% 100%);
	}

	/* Inner cut-out (background color) → leaves a thin triangular outline. */
	.tri::after {
		content: '';
		position: absolute;
		inset: 14%;
		background: var(--color-ink);
		clip-path: polygon(50% 0%, 100% 100%, 0% 100%);
	}

	.tri.up {
		animation: spin-cw 26s linear infinite;
	}
	.tri.down {
		animation: spin-ccw 26s linear infinite;
	}
	.tri.down::before {
		transform: rotate(180deg);
		background: linear-gradient(135deg, var(--color-ember-soft), #ffd0c2);
	}
	.tri.down::after {
		transform: rotate(180deg);
	}

	/* A faint pulsing halo — the still center the two fields turn around. */
	.halo {
		position: absolute;
		top: 50%;
		left: 50%;
		width: 14%;
		height: 14%;
		translate: -50% -50%;
		border-radius: 50%;
		background: radial-gradient(circle, var(--color-ember-soft), transparent 70%);
		animation: breathe 6s ease-in-out infinite;
	}

	@keyframes spin-cw {
		to {
			transform: translateZ(0) rotate(360deg);
		}
	}
	@keyframes spin-ccw {
		to {
			transform: translateZ(0) rotate(-360deg);
		}
	}
	@keyframes breathe {
		0%,
		100% {
			transform: scale(1);
			opacity: 0.5;
		}
		50% {
			transform: scale(2.2);
			opacity: 0.12;
		}
	}

	/* Rule 5: honor reduced motion — hold the form, drop the spin. */
	@media (prefers-reduced-motion: reduce) {
		.tri.up,
		.tri.down,
		.halo {
			animation: none;
		}
	}
</style>
