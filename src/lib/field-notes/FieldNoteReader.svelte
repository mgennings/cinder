<script lang="ts">
	import BenchPage from '$lib/ui/templates/BenchPage.svelte';
	import Button from '$lib/ui/atoms/Button.svelte';
	import QuietLink from '$lib/ui/atoms/QuietLink.svelte';
	import RuleHead from '$lib/ui/atoms/RuleHead.svelte';
	import Record from '$lib/ui/molecules/Record.svelte';
	import RecordRow from '$lib/ui/molecules/RecordRow.svelte';
	import TruthCard from '$lib/ui/molecules/TruthCard.svelte';
	import { READ_PRIVACY_CLAIM } from '$lib/field-note-privacy';
	import type { FieldNote } from './types';

	let { note }: { note: FieldNote } = $props();

	// The Python producer escapes and processes every block's HTML before it
	// reaches this component. Top-level note fields stay raw and never enter
	// {@html}; the route binds those fields as text and metadata instead.
	function stripHtml(value: string): string {
		return value.replace(/<[^>]+>/g, '');
	}

	// Consecutive metadata rows share one Record. Every other source block
	// becomes one design-system group, preserving the producer's order.
	type Group =
		| { type: 'title'; html: string }
		| { type: 'meta'; rows: { label: string; html: string }[] }
		| { type: 'section'; html: string }
		| { type: 'subsection'; html: string }
		| { type: 'paragraph'; html: string; dense: boolean }
		| { type: 'coda'; html: string }
		| { type: 'rule' }
		| { type: 'readout'; rows: { label: string; html: string }[] }
		| { type: 'claims'; rows: { title: string; html: string }[] }
		| { type: 'code'; text: string };

	// note_contract.py owns this house-format marker. The reader only uses it
	// to shift the already-validated technical half to its denser rhythm.
	const TECHNICAL_HALF_HEADING = 'the technical record';

	const groups: Group[] = $derived.by(() => {
		const out: Group[] = [];
		let pendingMeta: { label: string; html: string }[] = [];
		let dense = false;

		const flushMeta = () => {
			if (pendingMeta.length) {
				out.push({ type: 'meta', rows: pendingMeta });
				pendingMeta = [];
			}
		};

		for (const block of note.blocks) {
			if (block.kind === 'meta') {
				pendingMeta.push({ label: stripHtml(block.key), html: block.value });
				continue;
			}
			flushMeta();

			switch (block.kind) {
				case 'heading':
					if (block.level === 1) {
						out.push({ type: 'title', html: block.html });
					} else if (block.level === 2) {
						if (stripHtml(block.html).trim().toLowerCase() === TECHNICAL_HALF_HEADING) dense = true;
						out.push({ type: 'section', html: block.html });
					} else {
						out.push({ type: 'subsection', html: block.html });
					}
					break;
				case 'paragraph':
					out.push({ type: 'paragraph', html: block.html, dense });
					break;
				case 'coda':
					out.push({ type: 'coda', html: block.html });
					break;
				case 'rule':
					out.push({ type: 'rule' });
					break;
				case 'code':
					out.push({ type: 'code', text: block.lines.join('\n') });
					break;
				case 'table': {
					// "Claim / Reality" is the one table shape rendered as cards;
					// every other table remains a measured Record readout.
					const isClaims =
						block.header.length === 2 &&
						stripHtml(block.header[0]).trim().toLowerCase() === 'claim' &&
						stripHtml(block.header[1]).trim().toLowerCase() === 'reality';
					if (isClaims) {
						out.push({
							type: 'claims',
							rows: block.rows.map((row) => ({ title: stripHtml(row[0]), html: row[1] }))
						});
					} else {
						out.push({
							type: 'readout',
							rows: block.rows.map((row) => ({ label: stripHtml(row[0]), html: row[1] }))
						});
					}
					break;
				}
			}
		}
		flushMeta();
		return out;
	});
</script>

<BenchPage>
	<QuietLink href="/field-notes" class="mt-8">&larr; All field notes</QuietLink>

	{#each groups as group, i (i)}
		{#if group.type === 'title'}
			<h1 class="mt-4 text-3xl font-bold tracking-tight">{@html group.html}</h1>
		{:else if group.type === 'meta'}
			<Record class="mt-7">
				{#each group.rows as row (row.label)}
					<RecordRow label={row.label}>{@html row.html}</RecordRow>
				{/each}
			</Record>
		{:else if group.type === 'section'}
			<RuleHead class="mt-12">{@html group.html}</RuleHead>
		{:else if group.type === 'subsection'}
			<h3 class="mt-8 font-medium text-body">{@html group.html}</h3>
		{:else if group.type === 'paragraph'}
			<p
				class={group.dense
					? 'mt-3 text-sm leading-relaxed text-mist'
					: 'mt-4 text-[15px] leading-relaxed text-mist'}
			>
				{@html group.html}
			</p>
		{:else if group.type === 'coda'}
			<p class="mt-8 border-l-2 border-ember pl-4 text-sm leading-relaxed text-ghost">
				{@html group.html}
			</p>
		{:else if group.type === 'rule'}
			<hr class="mt-12 border-line" />
		{:else if group.type === 'readout'}
			<Record class="mt-3">
				{#each group.rows as row (row.label)}
					<RecordRow label={row.label} stacked class="text-mist">{@html row.html}</RecordRow>
				{/each}
			</Record>
		{:else if group.type === 'claims'}
			<div class="mt-3 space-y-3">
				{#each group.rows as row (row.title)}
					<TruthCard level={4} title={row.title} body={row.html} bodyIsHtml />
				{/each}
			</div>
		{:else if group.type === 'code'}
			<pre
				class="field mt-3 overflow-x-auto px-4 py-3 font-mono text-[12px] leading-relaxed text-ember-ink">{@html group.text}</pre>
		{/if}
	{/each}

	<p class="mt-12 border-t border-line pt-6 text-sm leading-relaxed text-mist">
		{READ_PRIVACY_CLAIM}
	</p>

	<div class="mt-8 flex flex-wrap gap-3">
		<Button href="/security" class="px-5 py-2.5 text-sm">How private is this, really?</Button>
		<Button href="/" class="px-5 py-2.5 text-sm">Send something</Button>
	</div>
</BenchPage>
