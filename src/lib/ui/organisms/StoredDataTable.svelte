<script lang="ts">
	// THE COMPLETE LIST OF WHAT AN ACCOUNT STORES. If a line of code ever stores
	// something that is not on this list, this list is the defect — which is why
	// it is data in one file rather than markup repeated in several.
	import Record from '../molecules/Record.svelte';
	import RecordRow from '../molecules/RecordRow.svelte';

	const stored = [
		{ label: 'From Apple or Google', value: 'An opaque account number' },
		{ label: 'Stored by Cinder', value: 'A one-way hash of that number' },
		{ label: 'Alongside it', value: 'Sends remaining, and the date of the last purchase' },
		{ label: 'Email address', value: 'Not requested, not stored' },
		{ label: 'Name', value: 'Not requested, not stored' },
		{ label: 'Notes and files', value: 'Never linked to any of this' }
	];
</script>

<Record class="mt-4">
	{#each stored as row (row.label)}
		<RecordRow label={row.label}>{row.value}</RecordRow>
	{/each}
</Record>
