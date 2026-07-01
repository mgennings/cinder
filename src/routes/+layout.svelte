<script lang="ts">
	// Favicon, manifest, and social meta live in app.html so they're present on
	// the very first byte, before hydration.
	import '../app.css';

	let { children } = $props();
</script>

{@render children()}
