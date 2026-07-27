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
const HOST = '127.0.0.1';

export default defineConfig({
	testDir: 'tests/e2e',
	timeout: 30_000,
	webServer: {
		command: `VITE_API_BASE=http://${HOST}:4000 pnpm dev --port ${PORT} --host ${HOST}`,
		url: `http://${HOST}:${PORT}`,
		reuseExistingServer: false,
		timeout: 120_000
	},
	use: {
		baseURL: `http://${HOST}:${PORT}`
	}
});
