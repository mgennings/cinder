// @vitest-environment node
//
// The CloudFront viewer-request function that fronts the whole site.
//
// The handler under test is NOT written here. It is extracted from the single
// place it actually ships from — `CinderViewerRequest.FunctionCode` in
// template.yaml — and executed as-is. This repo has already been bitten by two
// independent derivations of one string that had to agree byte for byte (see
// .notes/GOTCHAS.md on the part locator), so there is deliberately no second
// copy of this handler that could drift from the deployed one.
//
// It runs on EVERY request to cinder.ink, so a mistake here is the whole site,
// not one route.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const TEMPLATE_PATH = new URL('../../template.yaml', import.meta.url);
const RAW_TEMPLATE = readFileSync(TEMPLATE_PATH, 'utf8');

type CloudFrontRequest = {
	method: string;
	uri: string;
	querystring: Record<string, { value: string; multiValue?: { value: string }[] }>;
	headers: Record<string, { value: string }>;
	cookies: Record<string, { value: string }>;
};

type CloudFrontResult = CloudFrontRequest | { statusCode: number; headers: Record<string, { value: string }> };

/**
 * Pull a block scalar out of the raw template by key, without a YAML parser.
 *
 * A parser is not an option here: the template is full of SAM short tags
 * (`!Sub`, `!Ref`, `!GetAtt`) that plain YAML readers reject outright. Text
 * extraction is the honest tool, so it is strict — every failure throws rather
 * than returning an empty string that would make the whole suite pass vacuously.
 */
function extractBlockScalar(raw: string, key: string): { body: string; indent: string } {
	const lines = raw.split('\n');
	const startIndex = lines.findIndex((line) => new RegExp(`^\\s*${key}: !Sub \\|\\s*$`).test(line));

	if (startIndex === -1) throw new Error(`template.yaml has no "${key}: !Sub |" block`);

	const keyIndent = lines[startIndex].length - lines[startIndex].trimStart().length;
	const collected: string[] = [];

	for (let i = startIndex + 1; i < lines.length; i++) {
		const line = lines[i];
		const isBlank = line.trim() === '';
		const indent = line.length - line.trimStart().length;

		if (!isBlank && indent <= keyIndent) break;

		collected.push(line);
	}

	while (collected.length && collected[collected.length - 1].trim() === '') collected.pop();
	if (!collected.length) throw new Error(`"${key}" block in template.yaml is empty`);

	const bodyIndent = Math.min(
		...collected
			.filter((line) => line.trim() !== '')
			.map((line) => line.length - line.trimStart().length)
	);

	return {
		body: collected.map((line) => line.slice(bodyIndent)).join('\n'),
		indent: ' '.repeat(bodyIndent)
	};
}

/** Every `Parameters:` entry that carries a `Default:`, so `!Sub` can be resolved. */
function parameterDefaults(raw: string): Record<string, string> {
	const block = raw.slice(raw.indexOf('\nParameters:\n') + 1);
	const defaults: Record<string, string> = {};
	let current: string | null = null;

	for (const line of block.split('\n')) {
		if (/^\S/.test(line) && line.trim() !== 'Parameters:') break;

		const name = line.match(/^ {2}(\w+):\s*$/);
		if (name) {
			current = name[1];
			continue;
		}

		const value = line.match(/^ {4}Default:\s*(.+?)\s*$/);
		if (value && current) defaults[current] = value[1].replace(/^['"]|['"]$/g, '');
	}

	return defaults;
}

const EXTRACTED = extractBlockScalar(RAW_TEMPLATE, 'FunctionCode');
const DEFAULTS = parameterDefaults(RAW_TEMPLATE);

/** CloudFormation's `!Sub` substitution, applied exactly where the real deploy applies it. */
const HANDLER_SOURCE = EXTRACTED.body.replace(/\$\{(\w+)\}/g, (_match, name: string) => {
	if (!(name in DEFAULTS)) throw new Error(`!Sub references "${name}", which has no Default in template.yaml`);

	return DEFAULTS[name];
});

// `new Function` is the point, not a shortcut: the bytes CloudFormation ships to
// the edge are the bytes this suite executes. The only input is a git-tracked
// file in this repo, read at test time in a test-only module that never reaches
// a bundle — there is no untrusted string anywhere on this path.
const handler = new Function(`${HANDLER_SOURCE}\nreturn handler;`)() as (event: {
	request: CloudFrontRequest;
}) => CloudFrontResult;

function requestEvent(uri: string, host = 'cinder.ink', querystring: CloudFrontRequest['querystring'] = {}) {
	return { request: { method: 'GET', uri, querystring, headers: { host: { value: host } }, cookies: {} } };
}

function resolvedUri(uri: string, host?: string): string {
	const result = handler(requestEvent(uri, host));

	if (!('uri' in result)) throw new Error(`expected a request for ${uri}, got status ${result.statusCode}`);

	return result.uri;
}

describe('the tested handler is derived from template.yaml, not copied', () => {
	it('appears verbatim in the raw template at its original indentation', () => {
		const reindented = EXTRACTED.body
			.split('\n')
			.map((line) => (line === '' ? '' : EXTRACTED.indent + line))
			.join('\n');

		expect(RAW_TEMPLATE).toContain(reindented);
	});

	it('resolves every !Sub reference, leaving no unsubstituted placeholder', () => {
		expect(HANDLER_SOURCE).not.toContain('${');
		expect(HANDLER_SOURCE).toContain('cinder.ink');
	});

	it('is the only handler definition the template ships', () => {
		expect(EXTRACTED.body.match(/function handler\(/g)).toHaveLength(1);
		expect(RAW_TEMPLATE.match(/function handler\(/g)).toHaveLength(1);
	});
});

describe('apex canonicalization runs first and is untouched by the rewrite', () => {
	it('301s www to the apex with the path intact and no .html appended', () => {
		const result = handler(requestEvent('/security', 'www.cinder.ink'));

		expect(result).toMatchObject({
			statusCode: 301,
			headers: { location: { value: 'https://cinder.ink/security' } }
		});
	});

	it('carries the query string through the redirect', () => {
		const result = handler(
			requestEvent('/pro', 'www.cinder.ink', { plan: { value: 'year' }, ref: { value: 'a b' } })
		);

		expect(result).toMatchObject({
			headers: { location: { value: 'https://cinder.ink/pro?plan=year&ref=a%20b' } }
		});
	});

	it('matches the host case-insensitively', () => {
		expect(handler(requestEvent('/', 'WWW.CINDER.INK'))).toMatchObject({ statusCode: 301 });
	});

	it('leaves every other alias host alone', () => {
		for (const host of ['cinder.ink', 'cinder.uxuiai.org', 'blip.uxuiai.org']) {
			expect(handler(requestEvent('/security', host))).not.toHaveProperty('statusCode');
		}
	});
});

describe('extensionless routes resolve to their prerendered .html key', () => {
	// [ incoming uri, resulting request.uri, why ]
	const cases: [string, string, string][] = [
		['/', '/', 'DefaultRootObject owns the root'],
		['/index.html', '/index.html', 'already the root object'],
		['//', '//', 'empty last segment, nothing to alias'],

		['/security', '/security.html', 'top-level prerendered page'],
		['/field-notes', '/field-notes.html', 'top-level prerendered page'],
		['/pro', '/pro.html', 'top-level prerendered page'],
		['/account', '/account.html', 'top-level prerendered page'],
		['/signin', '/signin.html', 'top-level prerendered page'],
		['/signup', '/signup.html', 'top-level prerendered page'],

		['/pro/done', '/pro/done.html', 'nested page the old top-level alias loop never published'],
		[
			'/field-notes/the-vote-to-stay-blind',
			'/field-notes/the-vote-to-stay-blind.html',
			'nested page at arbitrary depth'
		],

		['/field-notes/', '/field-notes.html', 'one trailing slash is dropped, not sent to the shell'],
		['/pro/done/', '/pro/done.html', 'trailing slash at depth'],

		['/n/abc123', '/note.html', 'note shell rewrite wins and the dot rule leaves it alone'],
		['/n/', '/note.html', 'same shell for a bare prefix'],
		['/note.html', '/note.html', 'the shell itself is never re-aliased'],
		['/200.html', '/200.html', 'the SPA fallback is never re-aliased'],

		['/f/6vGqRnT', '/f/6vGqRnT.html', 'no prerendered page either way, still misses to the SPA shell'],

		['/app.js', '/app.js', 'dot in the last segment means a real asset'],
		['/favicon.ico', '/favicon.ico', 'dot in the last segment'],
		['/sitemap.xml', '/sitemap.xml', 'dot in the last segment'],
		['/robots.txt', '/robots.txt', 'dot in the last segment'],
		['/manifest.webmanifest', '/manifest.webmanifest', 'dot in the last segment'],
		[
			'/_app/immutable/entry/start.CqK1a9.js',
			'/_app/immutable/entry/start.CqK1a9.js',
			'hashed build asset at depth'
		],
		['/brand/cinder-mark.svg', '/brand/cinder-mark.svg', 'nested asset'],

		[
			'/.well-known/apple-app-site-association',
			'/.well-known/apple-app-site-association',
			'extensionless BY DESIGN — a .html rewrite would break universal links'
		],
		[
			'/.well-known/assetlinks.json',
			'/.well-known/assetlinks.json',
			'the future TWA file, guarded twice over'
		],
		['/.well-known', '/.well-known', 'the bare directory carries a dot of its own']
	];

	it.each(cases)('%s -> %s (%s)', (uri, expected) => {
		expect(resolvedUri(uri)).toBe(expected);
	});

	it('never touches the query string while rewriting the path', () => {
		const event = requestEvent('/pro/done', 'cinder.ink', { session: { value: 'cs_test_1' } });
		const result = handler(event) as CloudFrontRequest;

		expect(result.uri).toBe('/pro/done.html');
		expect(result.querystring).toEqual({ session: { value: 'cs_test_1' } });
	});
});
