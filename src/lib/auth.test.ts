import { describe, it, expect, beforeEach } from 'vitest';
import { intendedPath, takeReturnTo, peekReturnTo, startSignIn } from './auth';

// THE OPEN-REDIRECT GUARD, and nothing else. Everything else in auth.ts talks
// to Cognito, and a test that mocked Cognito would only be asserting the mock.
//
// This is the one piece of that file that is pure, security-relevant, and easy
// to get subtly wrong later: it decides whether a string from the URL bar is
// somewhere this site is willing to send a person after they authenticate.
// A wrong `yes` here hands somebody a cinder.ink link that lands them on
// somebody else's page having just signed in — the classic phishing shape.

describe('the destination a sign-in is allowed to return to', () => {
	beforeEach(() => sessionStorage.clear());

	it('accepts an ordinary same-origin path', () => {
		expect(intendedPath('?next=/pro')).toBe('/pro');
		expect(intendedPath('?next=/account')).toBe('/account');
		expect(intendedPath('?next=/pro?top=up#x')).toBe('/pro?top=up#x');
	});

	it('refuses everything that could leave this origin', () => {
		// Protocol-relative: resolves to another host with no scheme in sight.
		expect(intendedPath('?next=//evil.example')).toBeNull();
		// Absolute, including this site's own — an allowed absolute URL is one
		// parser disagreement away from an allowed foreign one.
		expect(intendedPath('?next=https://cinder.ink/pro')).toBeNull();
		expect(intendedPath('?next=javascript:alert(1)')).toBeNull();
		// Backslashes, because some browsers normalize them to slashes and
		// `/\evil.example` is `//evil.example` spelled to pass a naive check.
		expect(intendedPath('?next=/\\evil.example')).toBeNull();
		expect(intendedPath('?next=pro')).toBeNull();
		expect(intendedPath('')).toBeNull();
	});

	it('hands the destination back exactly once', () => {
		sessionStorage.setItem('cinder.returnto', '/pro');
		expect(peekReturnTo()).toBe('/pro');
		expect(takeReturnTo()).toBe('/pro');
		expect(takeReturnTo()).toBeNull();
	});

	it('never hands back a destination that was tampered with in storage', () => {
		sessionStorage.setItem('cinder.returnto', 'https://evil.example');
		expect(peekReturnTo()).toBeNull();
		expect(takeReturnTo()).toBeNull();
	});

	it('clears a stale destination when a sign-in starts without one', async () => {
		sessionStorage.setItem('cinder.returnto', '/pro');
		// No hosted UI is configured in this environment, so the redirect target is
		// a relative URL and jsdom refuses to navigate — which is fine. The point
		// is the storage decision made before the redirect, and that runs either
		// way. Awaiting the rejection keeps it from surfacing as an unhandled one.
		await startSignIn('Google').catch(() => {});
		expect(peekReturnTo()).toBeNull();
	});
});
