import { defineConfig } from '@playwright/test';

// Config for the ONE Cinder production check the UXQA registry may run
// unattended: tests/live/production-surface.spec.ts. Deliberately separate
// from playwright.config.ts, which owns local dev-server e2e/journey runs —
// this file has no webServer block at all, because it never starts anything
// local. It talks to the real deployed origin and nothing else.
//
// Always invoke by exact file path (`playwright test tests/live/production-surface.spec.ts
// --config=playwright.live-readonly.config.ts`), never `--testDir tests/live`,
// so this can never accidentally also collect tests/live/live.spec.ts — the
// attended create -> reveal -> destroy check that must stay a human action.
export default defineConfig({
	testDir: 'tests/live',
	timeout: 30_000,
	retries: 0,
	use: {
		baseURL: process.env.CINDER_PRODUCTION_ORIGIN || 'https://cinder.ink'
	}
});
