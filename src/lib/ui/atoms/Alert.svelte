<script lang="ts">
	// A failure that just happened, so role=alert rather than the page's polite
	// region: it interrupts, and the polite region is usually already busy
	// describing the state a person can see.
	import type { Snippet } from 'svelte';

	let {
		tone = 'plain',
		class: extra = '',
		children
	}: {
		/** plain = ember-ink text. boxed = a bordered panel, for a failure with no surface of its own. */
		tone?: 'plain' | 'boxed' | 'boxed-neutral';
		class?: string;
		children: Snippet;
	} = $props();

	const toneClass = {
		plain: 'text-sm text-ember-ink',
		boxed: 'rounded-md border border-ember/40 bg-ember/5 px-4 py-3 text-sm leading-relaxed text-body',
		'boxed-neutral':
			'rounded-md border border-line-strong bg-ink-raised px-4 py-3 text-sm leading-relaxed text-body'
	} as const;
</script>

<p role="alert" class="{toneClass[tone]} {extra}">{@render children()}</p>
