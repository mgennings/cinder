import { beforeEach, describe, expect, it, vi } from 'vitest';

import { rememberTransferStatus, transferStatusToken } from './status-store';

const locator = 'A'.repeat(43);
const token = (exp: number) => {
	const payload = btoa(JSON.stringify({ aud: 'cinder.sender-status', v: 1, locator, parts: 1, exp }))
		.replaceAll('+', '-')
		.replaceAll('/', '_')
		.replace(/=+$/, '');
	return `${payload}.signature`;
};

describe('sender status storage', () => {
	beforeEach(() => {
		localStorage.clear();
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-07-28T12:00:00Z'));
	});

	it('keeps only a valid on-device sender token and drops it at expiry', () => {
		const expiresAt = Math.floor(Date.now() / 1000) + 60;
		rememberTransferStatus(locator, token(expiresAt));
		expect(transferStatusToken(locator)).toBe(token(expiresAt));
		vi.advanceTimersByTime(60_000);
		expect(transferStatusToken(locator)).toBeNull();
	});
});
