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

	/* THE ONE THAT GOT THROUGH.

	   The six cases above are real and a mutation test proved they fire. They
	   also all missed this, because they describe characters somebody thought
	   of. The URL parser STRIPS ASCII tab, line feed, and carriage return before
	   it resolves, so a path holding one satisfies "starts with a single slash",
	   satisfies "no backslash", and then resolves to another origin. Found by an
	   independent review, reproduced in a real browser in one click.

	   Percent-encoded here because that is how it arrives on a query string, and
	   because a literal control character in a source file is invisible to
	   whoever reads this next. */
	it('refuses the control characters the URL parser strips before resolving', () => {
		for (const encoded of ['%09', '%0A', '%0D', '%00']) {
			expect(intendedPath(`?next=/${encoded}/evil.example`)).toBeNull();
			expect(intendedPath(`?next=/${encoded}%2F%2Fevil.example`)).toBeNull();
		}

		// And in storage, which is the other way in.
		for (const raw of ['/\u0009/evil.example', '/\u000a/evil.example', '/\u000d/evil.example']) {
			sessionStorage.setItem('cinder.returnto', raw);
			expect(peekReturnTo()).toBeNull();
			expect(takeReturnTo()).toBeNull();
		}
	});

	/* THE PROPERTY, asserted directly instead of by example.

	   This function has now been patched twice at the spelling that happened to
	   be observed. The first miss was a tab. The second was dot-segment removal:
	   `/.//evil.example` cleared every input check, and safePath then RETURNED
	   `//evil.example`, which the caller's own sink re-resolved to a foreign
	   host. Both were found by somebody trying one more spelling.

	   So the invariant is stated once, and any spelling that violates it fails
	   here whether or not it appears in the list below: whatever safePath hands
	   back, resolved against this origin, must still be on this origin. */
	it('never returns anything that resolves off this origin', () => {
		const ORIGIN = 'https://cinder.ink';
		const payloads = [
			'/.//evil.example',
			'/..//evil.example',
			'/a/..//evil.example',
			'/%2e//evil.example',
			'/%2e%2e//evil.example',
			'/././/evil.example',
			'//evil.example',
			'/pro',
			'/account?a=1#b',
			'/../etc/passwd'
		];

		for (const payload of payloads) {
			const out = intendedPath(`?next=${encodeURIComponent(payload)}`);
			if (out === null) continue;
			// The value is used as an href and as a goto target, so the thing that
			// must hold is about the RESULT, not about the input that produced it.
			expect(new URL(out, ORIGIN).origin, `safePath returned ${JSON.stringify(out)} for ${payload}`).toBe(
				ORIGIN
			);
		}
	});

	/* The guarantee that makes the blocklist above stop being load-bearing:
	   anything that changes the origin when resolved is refused, whether or not
	   anyone enumerated the character that did it. */
	it('refuses anything that resolves off this origin, and keeps what does not', () => {
		expect(intendedPath('?next=/pro')).toBe('/pro');
		expect(intendedPath('?next=/pro?a=1#b')).toBe('/pro?a=1#b');
		expect(intendedPath('?next=/../../etc/passwd')).toBe('/etc/passwd');
		expect(intendedPath('?next=%2F%2Fevil.example')).toBeNull();
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
