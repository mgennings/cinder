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

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const RAW_TEMPLATE = readFileSync(join(REPO_ROOT, 'template.yaml'), 'utf8');

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
	// This is a lossless round trip of a derivation against its own source, and
	// nothing more. `reindented` is `body` dedented by `bodyIndent` and then
	// re-prefixed with the same `bodyIndent`, so for every content line it
	// reconstructs the original BY CONSTRUCTION. Adding a real statement to the
	// shipped FunctionCode block leaves it green; the only mutation that reddens
	// it is a whitespace-only line inside the block, which the `line === ''`
	// branch maps to empty.
	//
	// So: it proves the extractor does not mangle, dedent too far, or drop a
	// line. It is NOT drift detection and must never be cited as such. Drift is
	// prevented structurally instead — there is exactly one copy of the handler
	// in this repo, and the `function handler(` count below is what enforces it.
	it('dedents losslessly — the extracted body re-indents back to the template text', () => {
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

	// CloudFront caps a function at 10240 bytes of SUBSTITUTED source, comments
	// included — and this one is deliberately comment-heavy, because the reasons
	// are the part that has to survive. Crossing the cap fails at `sam deploy`,
	// which is a production release. Cheaper to know here.
	it('fits inside the CloudFront Function size limit', () => {
		expect(Buffer.byteLength(HANDLER_SOURCE)).toBeLessThan(10240);
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

	// Key ORDER is deliberately not asserted. `encodeQuery` walks the querystring
	// object with `for…in`, and the real cloudfront-js-2.0 runtime returned the
	// two keys in both orders across runs of the same event. Local V8 happens to
	// be deterministic for string keys, so pinning the literal string would be
	// green here forever while asserting something the runtime never promised.
	//
	// What the redirect actually has to guarantee is the contract below: the
	// same origin and path, every pair present exactly once, each value still
	// percent-encoded, joined with `&` behind a single `?`. Splitting and sorting
	// tests all four without touching order.
	it('carries every query pair through the redirect, encoded, in any key order', () => {
		const result = handler(
			requestEvent('/pro', 'www.cinder.ink', { plan: { value: 'year' }, ref: { value: 'a b' } })
		) as { headers: Record<string, { value: string }> };

		const [base, query] = result.headers.location.value.split('?');

		expect(base).toBe('https://cinder.ink/pro');
		// Compared raw rather than through URL/URLSearchParams on purpose: both
		// parsers re-encode a literal space to %20 while reading, which would let
		// a dropped encodeURIComponent pass.
		expect(query.split('&').sort()).toEqual(['plan=year', 'ref=a%20b']);
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

		// The one row that makes the divergence from `fobkit-clean-urls`
		// executable instead of advisory. Cinder checks the LAST SEGMENT for a
		// dot; FobKit checks the whole URI. Both alignments a future agent might
		// reach for leave this row red and every other row green:
		//   uri.indexOf('.') === -1    (FobKit's whole-URI rule) -> unchanged
		//   lastIndexOf('/') -> indexOf('/')                     -> unchanged
		[
			'/a.b/c',
			'/a.b/c.html',
			'a dotted parent directory must not strand a clean last segment'
		],

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

// ---------------------------------------------------------------------------
// The single config change that turns the rewrite above into a site-wide outage
//
// `<path>` -> `<path>.html` is only the right key because adapter-static emits
// FLAT files. SvelteKit names each prerendered file after the path it rendered
// (@sveltejs/kit src/core/postbuild/prerender.js, `output_filename`): a path
// with no trailing slash becomes `<path>.html`, a path WITH one becomes
// `<path>/index.html`.
//
// So set the `trailingSlash` page option to 'always' and every prerendered path
// gains a slash: the build stops emitting `field-notes.html` and starts
// emitting `field-notes/index.html`. The rewrite then sends BOTH /field-notes
// and /field-notes/ to `/field-notes.html`, a key that no longer exists in the
// bucket — an origin miss, which CustomErrorResponses turns into HTTP 200
// serving the empty 200.html shell. Not one route. Every page on the site, at
// once, from a one-word config edit.
//
// 'ignore' is rejected for a related reason: it prerenders whichever shape the
// crawler happened to reach, so the key layout stops being predictable at all.
// 'never' is the default and the only value that guarantees the flat layout.
//
// If the option is ever genuinely wanted, the rewrite has to target the
// directory key instead — `uri + '/index.html'`. The sibling
// `ash-allure-clean-urls` CloudFront Function in this same account already does
// exactly that, and is the working reference. Change the rule first, then this
// guard.
//
// This warning previously existed only as a comment in scripts/deploy-frontend.sh
// on a branch that is not merging. A comment nobody runs is not a guard.
// ---------------------------------------------------------------------------

/** `export const trailingSlash: TrailingSlash = 'always'`, or a `trailingSlash: 'ignore'` config key. */
const TRAILING_SLASH_ASSIGNMENT = /trailingSlash(?:\s*:\s*\w+)?\s*[:=]\s*['"]([a-z]+)['"]/g;

const TRAILING_SLASH_SOURCE = /(^|\/)\+(?:(page|layout)(\.server)?|server)\.(js|ts)$/;

const TRAILING_SLASH_FAILURE = [
	'trailingSlash is set to something other than "never".',
	'',
	'That changes what adapter-static writes: `field-notes/index.html` instead of',
	'`field-notes.html`. The CloudFront viewer-request rewrite in template.yaml maps',
	'an extensionless path to `<path>.html`, so EVERY prerendered page would miss the',
	'origin at once and fall to the empty 200.html shell — the whole site, not one route.',
	'',
	'Fix the rewrite first (target `<path>/index.html`, as ash-allure-clean-urls does),',
	'then relax this guard. Do not relax it alone.'
].join('\n');

/**
 * Every file SvelteKit reads the `trailingSlash` page option from, plus the kit
 * config block. `+page`/`+layout` modules, their `.server` twins, and
 * `+server` modules may export it — see @sveltejs/kit src/utils/exports.js.
 */
function trailingSlashSources(): { path: string; text: string }[] {
	const routeFiles = readdirSync(join(REPO_ROOT, 'src/routes'), { recursive: true })
		.map((entry) => `src/routes/${entry}`)
		.filter((path) => TRAILING_SLASH_SOURCE.test(path));

	return ['vite.config.ts', ...routeFiles].map((path) => ({
		path,
		text: readFileSync(join(REPO_ROOT, path), 'utf8')
	}));
}

describe('the flat prerender layout the rewrite depends on', () => {
	it('recognizes every supported declaration shape', () => {
		expect([...`export const trailingSlash: TrailingSlash = 'always'`.matchAll(TRAILING_SLASH_ASSIGNMENT)][0]?.[1]).toBe(
			'always'
		);
		expect(TRAILING_SLASH_SOURCE.test('src/routes/api/+server.ts')).toBe(true);
	});

	it('has trailingSlash unset, or set to "never", everywhere SvelteKit reads it', () => {
		const sources = trailingSlashSources();

		// A bad glob or a moved directory must not turn this into a vacuous pass.
		expect(sources.map((source) => source.path)).toContain('vite.config.ts');
		expect(sources.length).toBeGreaterThan(5);

		const offenders = sources.flatMap((source) =>
			[...source.text.matchAll(TRAILING_SLASH_ASSIGNMENT)]
				.filter(([, value]) => value !== 'never')
				.map(([match]) => `${source.path}: ${match}`)
		);

		expect(offenders, TRAILING_SLASH_FAILURE).toEqual([]);
	});
});
