import { test } from 'node:test';
import assert from 'node:assert/strict';
import { absentProven, notRetrievable } from '../src/s3-errors.mjs';

const err = (name, httpStatusCode) =>
	Object.assign(new Error(name), { name, $metadata: { httpStatusCode } });

// --- the absence proof -----------------------------------------------------

test('a definitive 404 proves the object is gone', () => {
	assert.equal(absentProven(err('NotFound', 404)), null);
	assert.equal(absentProven(err('NoSuchKey', 404)), null);
});

test('a 403 is NOT an absence proof', () => {
	// This is the whole reason ClaimFileFn holds s3:ListBucket. Without it S3
	// answers 403 for a missing object, and accepting that here would mean
	// delivering bytes on the strength of "I could not look" — the exact
	// failure the absence check exists to prevent.
	assert.throws(() => absentProven(err('AccessDenied', 403)));
});

test('an outage is never mistaken for absence', () => {
	assert.throws(() => absentProven(err('InternalError', 500)));
	assert.throws(() => absentProven(err('SlowDown', 503)));
	assert.throws(() => absentProven(new Error('socket hang up')));
});

// --- the pre-destruction check ---------------------------------------------

test('missing and forbidden both mean "do not make this deliverable"', () => {
	assert.equal(notRetrievable(err('NoSuchKey', 404)), null);
	assert.equal(notRetrievable(err('AccessDenied', 403)), null);
});

test('a real outage still surfaces rather than silently refusing', () => {
	// A 500 here should not be laundered into a tidy 410 — that would turn an
	// S3 outage into "your transfer expired", which is a lie.
	assert.throws(() => notRetrievable(err('InternalError', 500)));
});

test('the two readings genuinely disagree on 403', () => {
	// If this ever stops being true, one of them has been edited to match the
	// other and the guarantee is gone.
	assert.equal(notRetrievable(err('AccessDenied', 403)), null);
	assert.throws(() => absentProven(err('AccessDenied', 403)));
});
