import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$app/navigation', () => ({
	replaceState: (url: string) => history.replaceState(null, '', url)
}));

import { videoEnabledForSession } from './feature-flag';

describe('video review feature flag', () => {
	beforeEach(() => {
		vi.unstubAllEnvs();
		sessionStorage.clear();
		history.replaceState(null, '', '/');
	});

	it('shows video by default only when the review build says so', () => {
		vi.stubEnv('VITE_VIDEO_REVIEW_DEFAULT', '1');

		expect(videoEnabledForSession()).toBe(true);
		expect(sessionStorage.getItem('cinder.video-review')).toBeNull();
	});

	it('keeps video hidden in an ordinary browser session', () => {
		expect(videoEnabledForSession()).toBe(false);
	});

	it('captures #video=on for this tab and immediately removes the fragment', async () => {
		history.replaceState(null, '', '/?review=local#video=on');

		expect(videoEnabledForSession()).toBe(true);
		await Promise.resolve();
		expect(location.pathname + location.search + location.hash).toBe('/?review=local');

		history.replaceState(null, '', '/');
		expect(videoEnabledForSession()).toBe(true);
	});

	it('does not capture or erase an unrelated fragment', () => {
		history.replaceState(null, '', '/#something-else');

		expect(videoEnabledForSession()).toBe(false);
		expect(location.hash).toBe('#something-else');
	});
});
