import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/*
  Three numbers have to agree, and until now nothing executable said so:

    PRO_CREDITS in src/lib/pro.ts   — what /pro PROMISES a purchase adds
    CinderProCredits in template.yaml — what the webhook actually GRANTS
    the Stripe Price                  — what the buyer is CHARGED

  Deploying with CinderProCredits=20 would leave /pro advertising ten sends
  while the webhook granted twenty, silently, and nothing would have noticed.
  A review flagged that the only guard was a checklist line a human reads.

  The Stripe Price lives in Stripe, not in this repo, so this test cannot reach
  it. It pins the two that ARE here and names the third as the human step, which
  is the honest boundary: a test that pretended to verify the price would be
  worse than one that says plainly where its knowledge stops.
*/

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');

const read = (p) => readFileSync(resolve(repo, p), 'utf8');

test('the credits /pro promises match the credits the stack grants', () => {
	const pro = read('src/lib/pro.ts');
	const template = read('template.yaml');

	const promised = pro.match(/PRO_CREDITS\s*=\s*(\d+)/);
	assert.ok(promised, 'PRO_CREDITS not found in src/lib/pro.ts');

	const granted = template.match(/CinderProCredits:[\s\S]*?Default:\s*(\d+)/);
	assert.ok(granted, 'CinderProCredits default not found in template.yaml');

	assert.equal(
		Number(promised[1]),
		Number(granted[1]),
		`/pro promises ${promised[1]} credits but the stack default grants ${granted[1]}. ` +
			`Change both, and change the Stripe Price to match what the bundle is worth.`
	);
});

test('the price /pro shows is a real dollar amount, and the deploy note names the cents', () => {
	const pro = read('src/lib/pro.ts');

	const price = pro.match(/PRO_PRICE\s*=\s*'\$(\d+)\.(\d{2})'/);
	assert.ok(price, "PRO_PRICE must look like '$4.94' so the cents are unambiguous");

	const cents = Number(price[1]) * 100 + Number(price[2]);
	assert.ok(cents > 0, 'price must be positive');

	// The one that actually bit: a Stripe Price created at 94 instead of 494
	// charges 90% less and nothing in the product notices, because Stripe is the
	// only party that knows what was charged.
	assert.ok(
		read('docs/pro-payments.md').includes(String(cents)),
		`docs/pro-payments.md must state the Stripe unit_amount in cents (${cents}), ` +
			`because a Price created at the dollar figure instead of the cent figure ` +
			`undercharges silently`
	);
});
