import { replaceState } from '$app/navigation';

const VIDEO_SESSION_KEY = 'cinder.video-review';

/**
 * Captures the hidden video review fragment for this browser tab.
 *
 * The URL is cleaned before storage is touched so the review switch never
 * remains in copied links, screenshots, or browser history.
 */
export function videoEnabledForSession(): boolean {
	if (typeof window === 'undefined') return false;

	const captured = new URLSearchParams(location.hash.slice(1)).get('video') === 'on';
	if (captured) {
		const cleanUrl = location.pathname + location.search;
		// Initial afterNavigate callbacks run while SvelteKit is still completing
		// hydration. The next microtask is the first moment its router accepts a
		// replaceState call, and still clears the fragment in the same turn.
		queueMicrotask(() => replaceState(cleanUrl, {}));
		try {
			sessionStorage.setItem(VIDEO_SESSION_KEY, 'on');
		} catch {
			return true;
		}
	}

	try {
		return captured || sessionStorage.getItem(VIDEO_SESSION_KEY) === 'on';
	} catch {
		return captured;
	}
}
