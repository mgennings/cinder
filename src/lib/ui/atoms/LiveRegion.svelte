<script lang="ts">
	// One polite region per page, mounted outside every view branch. An earlier
	// version of the reveal page put it inside a branch, so it unmounted at the
	// exact moment there was something worth saying.
	let {
		message,
		atomic = false
	}: {
		message: string;
		/** Read the whole sentence rather than the diff. */
		atomic?: boolean;
	} = $props();
</script>

<p aria-live="polite" aria-atomic={atomic ? 'true' : undefined} class="sr-only">{message}</p>
