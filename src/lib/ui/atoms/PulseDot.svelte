<script lang="ts">
	// "This is happening now", as a lamp. Purely decorative reinforcement — the
	// words beside it always carry the meaning — so it is hidden from assistive
	// technology rather than given a label it would only repeat.
	let { class: extra = 'bg-ember' }: { class?: string } = $props();
</script>

<span aria-hidden="true" class="pulse-dot inline-block h-2 w-2 rounded-full {extra}"></span>
