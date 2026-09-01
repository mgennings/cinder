import { replaceState } from '$app/navigation';

const VIDEO_SESSION_KEY = 'cinder.video-review';

/** Capture a one-shot video review URL into this browser tab. */
export function videoEnabledForSession(): boolean {
	if (typeof window === 'undefined') return false;

	const url = new URL(location.href);
	const fragment = new URLSearchParams(url.hash.slice(1));
	const legacyFragment = url.hash === '#video-on';
	const fragmentRequest = fragment.get('video');
	const requested = url.searchParams.get('video') ?? fragmentRequest ?? (legacyFragment ? 'on' : null);

	if (requested === 'on' || requested === 'off') {
		url.searchParams.delete('video');
		if (legacyFragment) url.hash = '';
		else if (fragmentRequest) {
			fragment.delete('video');
			url.hash = fragment.toString();
		}
		const cleanUrl = url.pathname + url.search + url.hash;
		// Initial afterNavigate callbacks run while SvelteKit is still completing
		// hydration. The next microtask is the first moment its router accepts a
		// replaceState call, and still clears the switch in the same turn.
		queueMicrotask(() => replaceState(cleanUrl, {}));
		try {
			sessionStorage.setItem(VIDEO_SESSION_KEY, requested);
		} catch {
			return requested === 'on';
		}
		return requested === 'on';
	}

	try {
		const stored = sessionStorage.getItem(VIDEO_SESSION_KEY);
		if (stored === 'on') return true;
		if (stored === 'off') return false;
	} catch {
		// Storage is optional. The build default still works without it.
	}

	return import.meta.env.VITE_VIDEO_REVIEW_DEFAULT === '1';
}
