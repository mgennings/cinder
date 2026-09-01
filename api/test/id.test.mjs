import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveChunkLocator, deriveSegmentLocator } from '../src/id.mjs';

// The part-locator derivation lives in TWO places that must agree byte for
// byte: here, and derivePartLocator in src/lib/link.ts. The browser side pins
// itself against constants produced by THIS side (src/lib/link.test.ts), which
// catches a client-side change — but a change to this file alone would leave
// those constants stale and both suites green while the two implementations
// disagree in production. This test is the other half of the pin: the same
// constants, asserted against the Node side, so whichever side moves goes red
// in its own suite.

test('part locators match the constants the browser side is pinned to', () => {
	assert.equal(
		deriveChunkLocator('the-transfer-locator', 0),
		'EZs_axYFbYFTg6Q4tTLX93h2MjtjYayJ1sFr3neNrkU'
	);
	assert.equal(
		deriveChunkLocator('the-transfer-locator', 1),
		'PXYZFNtL5h25OK5daKVzSGE3Yr3om0ZB_z5aRAWa-rY'
	);
	assert.equal(
		deriveChunkLocator('the-transfer-locator', 7),
		'FaZ0Hg0YQz37DVi3oZLWtjnq1LGol1pfFh_q-2H78nM'
	);
});

test('video segment locators ARE part locators, not a third derivation', () => {
	// docs/ephemeral-video-design.md: video reuses the part derivation rather
	// than inventing another string two more files would have to agree on. If
	// someone replaces the alias with its own implementation and it drifts,
	// every segment answers 410 and nothing else notices — this notices.
	assert.equal(deriveSegmentLocator, deriveChunkLocator);
	assert.equal(
		deriveSegmentLocator('the-transfer-locator', 127),
		deriveChunkLocator('the-transfer-locator', 127)
	);
});
