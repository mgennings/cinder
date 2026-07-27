import { defineConfig } from '@playwright/test';

// Assumes DynamoDB Local is already running on :8000 (scripts/dynamodb-local.sh)
// and the dev-api on :4000. Vite dev serves the app with VITE_API_BASE pointed
// at the dev-api so the browser talks to the real handlers.
//
// Three deliberate choices here, each of which cost a false red before it was
// made. All of them are about being certain WHICH server answered.
//
//  1. A dedicated port. The default 5173 is what every other SvelteKit repo on
//     this machine also uses, and two dev servers can hold it simultaneously —
//     one bound to 127.0.0.1 and one to [::1]. They do not collide, so nothing
//     errors; Chromium simply resolves `localhost` to IPv4 first and the suite
//     silently tests a different product. That failure reads as nine broken
//     features.
//  2. 127.0.0.1 everywhere, never `localhost`, so the address family is never
//     up to a resolver.
//  3. `reuseExistingServer: false`, so Playwright starts and owns the server it
//     tests. Attaching to whatever was already running is how a config change
//     or a stale process gets silently tested instead of the current code.
const PORT = 5178;
const JOURNEY_PORT = 5179;
const HOST = '127.0.0.1';

// TWO front ends, because they are configured differently and the difference is
// the point.
//
//   5178  tests/e2e     carries VITE_DEV_CAPABILITY_GRANT and no identity API.
//                       It tests the transport with the gate satisfied by a
//                       literal, which is what lets those specs run with nothing
//                       but the dev API and DynamoDB Local.
//   5179  tests/journey carries NO dev grant and a real identity API. Every
//                       capability it gets is minted by scripts/dev-identity.mjs
//                       and verified by the shipped gate. A dev grant here would
//                       let the journey succeed while unpaid, which is precisely
//                       the failure that suite exists to catch.
const server = (port: number, env: string) => ({
	command: `${env} pnpm dev --port ${port} --host ${HOST}`,
	url: `http://${HOST}:${port}`,
	reuseExistingServer: false,
	timeout: 120_000
});

export default defineConfig({
	timeout: 30_000,
	webServer: [
		server(PORT, `VITE_API_BASE=http://${HOST}:4000 VITE_DEV_CAPABILITY_GRANT=dev-capability-grant`),
		server(
			JOURNEY_PORT,
			`VITE_API_BASE=http://${HOST}:4000 VITE_IDENTITY_API_BASE=http://${HOST}:4100 VITE_IDENTITY_HOSTED_UI=http://${HOST}:4100 VITE_IDENTITY_CLIENT_ID=dev-cinder-client`
		)
	],
	projects: [
		{ name: 'e2e', testDir: 'tests/e2e', use: { baseURL: `http://${HOST}:${PORT}` } },
		{ name: 'journey', testDir: 'tests/journey', use: { baseURL: `http://${HOST}:${JOURNEY_PORT}` } }
	]
});
