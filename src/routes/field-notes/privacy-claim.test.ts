import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NO_EDGE_RECORD_CLAUSE, READ_PRIVACY_CLAIM } from '../../lib/field-note-privacy';

// The half of the anonymity promise a browser cannot reach.
//
// tests/e2e/field-notes-privacy.spec.ts proves what happens inside the page:
// no cookie, no storage write, no third-party request, no web font. None of
// that can see the edge. CloudFront standard access logs and S3 server access
// logs record client IP, URI, user agent, and referrer, they are a console
// toggle away, and turning them on changes no code and breaks no browser test.
// Today they are off by OMISSION — template.yaml simply has no Logging key —
// which is not the same thing as being off by guard.
//
// So this is the guard. It reads the deployed template and refuses to let the
// published sentence and the edge configuration drift apart: the moment logging
// appears on the site distribution or the site bucket, this goes red and says
// which sentence has to change with it.
//
// template.yaml is reserved by another lane. This file only READS it.

// Resolved from the vitest root, not from import.meta.url: Vite serves this
// module over http during a run, so a file URL built from it throws
// "The URL must be of scheme file" before a single assertion executes.
const TEMPLATE = readFileSync(resolve(process.cwd(), 'template.yaml'), 'utf8');

// Pull one top-level resource out of the SAM template without taking on a YAML
// dependency for a question this narrow. Resources sit at exactly two spaces of
// indent under `Resources:`, so a block runs from its own line until the next
// line indented two spaces or fewer.
function resourceBlock(template: string, logicalId: string): string {
	const lines = template.split('\n');
	const start = lines.indexOf(`  ${logicalId}:`);
	if (start === -1) throw new Error(`template.yaml has no resource named ${logicalId}`);

	const body = lines.slice(start + 1);
	const end = body.findIndex((line) => line.trim() !== '' && !line.startsWith('   '));
	return (end === -1 ? body : body.slice(0, end)).join('\n');
}

// Anchored to start-of-line whitespace so a commented-out `# Logging:` does not
// count, and so `LoggingConfiguration` is never mistaken for CloudFront's
// shorter `Logging` key.
const ACCESS_LOG_KEYS: Record<string, RegExp> = {
	SiteDistribution: /^\s+Logging:\s*$/m, // CloudFront standard access logs
	SiteBucket: /^\s+LoggingConfiguration:\s*$/m // S3 server access logs
};

function loggedResources(template: string): string[] {
	return Object.entries(ACCESS_LOG_KEYS)
		.filter(([logicalId, key]) => key.test(resourceBlock(template, logicalId)))
		.map(([logicalId]) => logicalId);
}

// Copies of the real template with logging switched on, shaped the way
// CloudFormation actually accepts it, anchored to a line that is unique to the
// resource being altered. These are the injection proof kept permanently rather
// than performed once by hand: loosen the detector and these go red.
const withDistributionLogging = () =>
	TEMPLATE.replace(
		'        DefaultRootObject: index.html',
		'        DefaultRootObject: index.html\n        Logging:\n          Bucket: cinder-access-logs.s3.amazonaws.com'
	);

const withBucketLogging = () =>
	TEMPLATE.replace(
		"      BucketName: !Sub 'blip-site-${AWS::AccountId}'",
		"      BucketName: !Sub 'blip-site-${AWS::AccountId}'\n      LoggingConfiguration:\n        DestinationBucketName: cinder-access-logs"
	);

describe('the field-note privacy claim and the edge that could falsify it', () => {
	it('detects access logging on the site distribution', () => {
		const injected = withDistributionLogging();
		// If the anchor line ever moves, the fixture silently becomes a copy of
		// a clean template and the assertion below passes for the wrong reason.
		expect(injected, 'the SiteDistribution anchor line no longer exists').not.toBe(TEMPLATE);
		expect(loggedResources(injected)).toEqual(['SiteDistribution']);
	});

	it('detects access logging on the site bucket', () => {
		const injected = withBucketLogging();
		expect(injected, 'the SiteBucket anchor line no longer exists').not.toBe(TEMPLATE);
		expect(loggedResources(injected)).toEqual(['SiteBucket']);
	});

	it('ignores a commented-out logging key', () => {
		const commented = TEMPLATE.replace(
			'        DefaultRootObject: index.html',
			'        DefaultRootObject: index.html\n        # Logging:'
		);
		expect(commented).not.toBe(TEMPLATE);
		expect(loggedResources(commented)).toEqual([]);
	});

	it('holds the deployed template to what the published sentence claims', () => {
		expect(
			loggedResources(TEMPLATE),
			`Access logging is now configured for the resource(s) above. Client IP, URI, user agent, ` +
				`and referrer are being recorded for every field-note read, so "${NO_EDGE_RECORD_CLAUSE}" ` +
				`in src/lib/field-note-privacy.ts is no longer true. Correct that sentence in the same ` +
				`commit that turns logging on, then update this assertion to match.`
		).toEqual([]);

		// The other direction: the sentence cannot quietly lose the clause this
		// guard exists to protect while the template stays clean.
		expect(READ_PRIVACY_CLAIM).toContain(NO_EDGE_RECORD_CLAUSE);
	});
});
