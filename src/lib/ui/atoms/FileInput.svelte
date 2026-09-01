<script lang="ts">
	// The native input still owns the picker, keyboard behavior, accessibility
	// tree, and selected FileList. It fills this visible field invisibly because
	// browsers render the native button and filename as one unwrappable line;
	// at 200% text Safari and Chromium both clipped that line inside the card.
	import type { HTMLInputAttributes } from 'svelte/elements';

	let {
		class: extra = '',
		onchange,
		...rest
	}: { class?: string } & HTMLInputAttributes = $props();

	let filename = $state('No file selected');

	function handleChange(event: Event) {
		onchange?.(event as Parameters<NonNullable<typeof onchange>>[0]);
		const input = event.currentTarget as HTMLInputElement;
		filename = input.files?.[0]?.name ?? 'No file selected';
	}
</script>

<span class="file-field field {extra}">
	<span class="file-action" aria-hidden="true">Choose file</span>
	<span class="file-name" aria-hidden="true">{filename}</span>
	<input type="file" class="file-input" onchange={handleChange} {...rest} />
</span>

<style>
	.file-field {
		position: relative;
		display: flex;
		min-width: 0;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px 12px;
		padding: 12px 16px;
		cursor: pointer;
	}

	.file-action {
		flex: 0 0 auto;
		border-radius: calc(var(--radius-field) - 0.25rem);
		background: var(--color-ink-raised);
		padding: 6px 12px;
		font-weight: 600;
		color: var(--color-body);
	}

	.file-name {
		min-width: 0;
		flex: 1 1 8rem;
		overflow-wrap: anywhere;
	}

	.file-input {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		margin: 0;
		opacity: 0;
		cursor: pointer;
	}

	.file-field:has(.file-input:focus-visible) {
		border-color: var(--color-ember);
		box-shadow: var(--focus-ring);
	}

	.file-field:has(.file-input:disabled) {
		cursor: not-allowed;
		opacity: 0.5;
	}

	.file-input:disabled {
		cursor: not-allowed;
	}

	@media (forced-colors: active) {
		.file-action {
			border: 1px solid ButtonBorder;
		}
	}
</style>
