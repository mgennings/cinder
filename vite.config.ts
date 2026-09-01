import adapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import type { Config } from '@sveltejs/kit';
import { loadEnv } from 'vite';

// SvelteKit declares its `Csp` namespace but does not export it, so the source
// type is derived from the exported config shape instead of being copied here.
// Copying it would silently drift the day upstream changes it.
type CspSources = NonNullable<
	NonNullable<NonNullable<Config['kit']>['csp']>['directives']
>['connect-src'];
// defineConfig comes from vitest so the `test` block below is typed; loadEnv is
// not re-exported there, so it comes straight from vite.
import { defineConfig } from 'vitest/config';

// The media bucket the API hands out presigned uploads for. It is a fixed
// deployment fact rather than a secret, and `connect-src` has to name it
// explicitly or the browser will refuse the upload.
const MEDIA_ORIGIN = 'https://blip-media-553806908724.s3.us-east-1.amazonaws.com';

export default defineConfig(({ mode }) => {
	// Derive the allowed API origin from the SAME value the app actually calls
	// (src/lib/api.ts reads VITE_API_BASE). Hardcoding the production API here
	// would silently block every request in local dev and in the Playwright
	// suite, where the API is http://localhost:4000 — a CSP that is only correct
	// in production is a CSP nobody exercises before shipping.
	// `loadEnv` reads .env FILES only. Vite also exposes any VITE_-prefixed
	// shell variable to the client, and playwright.config.ts and every phone
	// review pass the API base exactly that way. Reading only the files meant
	// the app called an origin the policy never named, so the browser refused
	// the upload before it left and the surface reported a dropped connection.
	// The shell wins because it is the more specific of the two.
	const env = { ...loadEnv(mode, process.cwd(), 'VITE_'), ...process.env };
	const apiOrigin = env.VITE_API_BASE ? new URL(env.VITE_API_BASE).origin : null;

	// The identity API and the Cognito hosted UI, derived the same way and for
	// the same reason. Both are absent from a build with no accounts configured,
	// and absent from the policy too — a CSP should never name an origin the
	// build cannot call. The hosted UI is also a redirect TARGET, but `form-action`
	// stays 'none': the browser leaves via location.assign, not a form post.
	const identityOrigins = [env.VITE_IDENTITY_API_BASE, env.VITE_IDENTITY_HOSTED_UI]
		// A typed predicate, not `filter(Boolean)`: the merged env can hold
		// undefined now that process.env is part of it, and Boolean does not
		// narrow the type for the `new URL` below.
		.filter((u): u is string => Boolean(u))
		.map((u) => new URL(u).origin);

	// SvelteKit types CSP sources as a template-literal union of scheme, host,
	// and port shapes. An origin computed at runtime is just a string and does
	// not narrow to it, so it gets one assertion here, at the single boundary,
	// rather than loosening the directive types everywhere.
	const connectSrc = [
		'self',
		...(apiOrigin ? [apiOrigin] : []),
		...identityOrigins,
		MEDIA_ORIGIN
	] as CspSources;

	return {
		plugins: [
			tailwindcss(),
			sveltekit({
				compilerOptions: {
					// Force runes mode across the project, except for libraries. Removable in Svelte 6.
					runes: ({ filename }) =>
						filename.split(/[/\\]/).includes('node_modules') ? undefined : true
				},

				// Static SPA: any /n/<id> URL falls back to the shell and resolves client-side.
				adapter: adapter({ fallback: '200.html' }),

				// The served JavaScript IS the encryption. A strict policy does not
				// defend against Cinder itself — nothing can, and docs/security.md
				// says so plainly — but it does mean an injected or third-party
				// script has nowhere to run and nowhere to send anything.
				//
				// `mode: 'hash'` because the one inline script is SvelteKit's
				// bootstrap and its hash changes every build; a static header could
				// only cover it with 'unsafe-inline', which would defeat the point.
				// `frame-ancestors` is absent on purpose — it is ignored inside a
				// meta tag and is set at the CloudFront edge instead (template.yaml).
				csp: {
					mode: 'hash',
					directives: {
						'default-src': ['none'],
						'script-src': ['self'],
						'style-src': ['self', 'unsafe-inline'],
						'img-src': ['self', 'data:'],
						// A video is decrypted on this device and played back from an
						// object URL the page itself created, so `blob:` is the only
						// source it ever needs. Without this directive media falls back
						// to `default-src: 'none'` and the browser refuses the page's
						// own blob, which reads as a video that silently never plays.
						// This grants no network destination: `connect-src` still names
						// the only origins anything can be fetched from or sent to, so
						// what leaves the device is unchanged.
						'media-src': ['self', 'blob:'],
						'font-src': ['self'],
						'manifest-src': ['self'],
						'worker-src': ['self'],
						// The API and the private media bucket. Nothing else — a script
						// that wanted to exfiltrate a key would have nowhere to send it.
						'connect-src': connectSrc,
						'base-uri': ['none'],
						'form-action': ['none']
					}
				}
			})
		],
		server: {
			// Vite refuses any Host header it was not told about, which is right: it
			// is what stops a page somebody else controls from pointing a name at a
			// dev server on this machine. The cost is that reviewing cinder on a
			// phone over the private tailnet arrives as "Blocked request" with
			// nothing to suggest the address was ever meant to work.
			//
			// The private switcher passes the tailnet name in CINDER_PHONE_HOST while
			// it is publishing over HTTPS, and passes nothing otherwise. So this is
			// empty by default and holds exactly one name during phone review. No
			// wildcard, and no hostname stored in this repository.
			//
			// No port here on purpose. Playwright pins 5178 and 5179 itself
			// (playwright.config.ts) and the switcher passes its own on the command
			// line; a port in this file would fight both.
			allowedHosts: process.env.CINDER_PHONE_HOST ? [process.env.CINDER_PHONE_HOST] : []
		},
		test: {
			environment: 'jsdom',
			include: ['src/**/*.test.ts']
		}
	};
});
