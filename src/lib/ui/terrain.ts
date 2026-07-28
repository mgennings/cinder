import type { Attachment } from 'svelte/attachments';

// Steering for the signal terrain — the surveyor's grid under the vault glow.
//
// The whole interaction is two custom-property writes. There is no loop, no
// canvas, no timer, and nothing that runs when the pointer is still: a
// `pointermove` listener coalesced into one animation frame writes `--sx`/`--sy`
// on the element, and CSS does the rest on the compositor. Both properties
// default to 0 in `app.css`, so the terrain composed by this file is the same
// terrain a page renders with no script at all.
//
// It attaches to nothing it does not need to:
//
//   - `prefers-reduced-motion: reduce` — never attaches. A field that cannot be
//     stilled is a defect, and the cheapest way to still it is to not start it.
//   - a coarse pointer — never attaches. On a phone the only "pointer move" is
//     a scroll or a drag, so steering there would shift the background under
//     someone's thumb while they are reading.
//
// There is deliberately no keyboard equivalent. An arrow-key handler is owed to
// a visualization that CARRIES something; this one is decoration over a glow and
// is `aria-hidden` by construction, so the honest accessible treatment is to
// leave it out of the interaction model entirely rather than put a focus stop in
// the tab order that leads to a background.
export function terrain(): Attachment<HTMLElement> {
	return (node) => {
		const still = matchMedia('(prefers-reduced-motion: reduce)');
		const coarse = matchMedia('(pointer: coarse)');
		if (still.matches || coarse.matches) return;

		let frame = 0;
		let x = 0;
		let y = 0;

		const paint = () => {
			frame = 0;
			node.style.setProperty('--sx', x.toFixed(3));
			node.style.setProperty('--sy', y.toFixed(3));
		};

		const onMove = (e: PointerEvent) => {
			const box = node.getBoundingClientRect();
			// -1..1 from the center, so the grid leans toward the pointer by a few
			// pixels rather than tracking it. The terrain is a room reacting to
			// someone walking through it, not a cursor with a background attached.
			x = ((e.clientX - box.left) / box.width) * 2 - 1;
			y = ((e.clientY - box.top) / box.height) * 2 - 1;
			frame ||= requestAnimationFrame(paint);
		};

		// Settle back to the composed frame when the pointer leaves, so the page
		// never holds a lean that nothing on screen explains.
		const onLeave = () => {
			x = 0;
			y = 0;
			frame ||= requestAnimationFrame(paint);
		};

		node.addEventListener('pointermove', onMove, { passive: true });
		node.addEventListener('pointerleave', onLeave, { passive: true });

		return () => {
			cancelAnimationFrame(frame);
			node.removeEventListener('pointermove', onMove);
			node.removeEventListener('pointerleave', onLeave);
		};
	};
}
