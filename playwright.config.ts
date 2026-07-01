import { defineConfig } from '@playwright/test';

// Assumes DynamoDB Local is already running on :8000 (scripts/dynamodb-local.sh)
// and the dev-api on :4000. Vite dev serves the app with VITE_API_BASE pointed
// at the dev-api so the browser talks to the real handlers.
export default defineConfig({
	testDir: 'tests/e2e',
	timeout: 30_000,
	webServer: {
		command: 'VITE_API_BASE=http://localhost:4000 pnpm dev --port 5173',
		port: 5173,
		reuseExistingServer: true,
		timeout: 60_000
	},
	use: {
		baseURL: 'http://localhost:5173'
	}
});
