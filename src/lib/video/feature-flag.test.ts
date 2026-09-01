import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$app/navigation', () => ({
	replaceState: (url: string) => history.replaceState(null, '', url)
}));

import { videoEnabledForSession } from './feature-flag';

describe('video review feature flag', () => {
	beforeEach(() => {
		sessionStorage.clear();
		history.replaceState(null, '', '/');
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
