<script lang="ts">
	// THE ONE SIGNATURE SURFACE OF THE FILE JOURNEY, and the only place in the
	// product where the machine reports on itself.
	//
	// Every row is a fact. Four are entailed by the bytes the page is holding —
	// the server cannot return a body until the delete and the absence check have
	// both succeeded. The fifth is entailed by the key never having left the
	// fragment. Nothing may be added here that is not entailed by something that
	// already happened.
	import Record from '../molecules/Record.svelte';
	import RecordRow from '../molecules/RecordRow.svelte';
	import { humanSize, middleTruncate } from '../format';

	let {
		name,
		bytes,
		partCount = 1
	}: {
		name: string;
		bytes: number;
		/** 1 for a single file. Above 1, the piece row appears. */
		partCount?: number;
	} = $props();

	const chunked = $derived(partCount > 1);
</script>

<Record>
	<!-- Mono for the two rows that are measurements rather than statements. A
	     filename and a byte count are what the machine read off the bytes in this
	     tab; the rows below them are claims about what the server did, and a
	     claim set in mono borrows an authority it should have to earn in words. -->
	<RecordRow label="File" data class="break-all" title={name}>{middleTruncate(name)}</RecordRow>
	<RecordRow label="Size" data>{humanSize(bytes)}</RecordRow>
	{#if chunked}
		<RecordRow label="Pieces" mark>{partCount} of {partCount} delivered</RecordRow>
	{/if}
	<RecordRow label="Delivery" mark>Consumed</RecordRow>
	<RecordRow label="Stored {chunked ? 'pieces' : 'copy'}" mark>Deleted, absence verified</RecordRow>
	<RecordRow label="Decryption" mark>This device only</RecordRow>
</Record>
