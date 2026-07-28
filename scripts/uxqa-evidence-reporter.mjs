// A Playwright reporter, not a runner-side synthesis step: the UXQA runner
// (Messiah scripts/uxqa/run.mjs) only ever VALIDATES the evidence document a
// gate wrote, never invents one, and the registry contract forbids passing
// this script any argument the runner didn't already approve — so the
// reporter is wired through playwright.live-readonly.config.ts's own
// `reporter` option, which is part of the approved, hashed script string,
// not an extra runtime flag.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

function git(args) {
	try {
		return execFileSync('git', args, { encoding: 'utf8', cwd: process.cwd() }).trim();
	} catch {
		return null;
	}
}

export default class UxqaEvidenceReporter {
	constructor() {
		this.results = [];
	}

	onTestEnd(_test, result) {
		this.results.push({ status: result.status, durationMs: result.duration });
	}

	onEnd() {
		const passed = this.results.filter((r) => r.status === 'passed').length;
		const failed = this.results.filter((r) => r.status === 'failed' || r.status === 'timedOut').length;
		const skipped = this.results.filter((r) => r.status === 'skipped' || r.status === 'interrupted').length;
		const durationMs = this.results.reduce((sum, r) => sum + r.durationMs, 0);
		const deep = process.env.CINDER_UXQA_MODE === 'deep';

		const evidence = {
			schema: 'org.uxuiai.uxqa-evidence.v1',
			sourceRevision: git(['rev-parse', 'HEAD']) ?? 'unknown',
			deployedRevision: 'unknown', // Cinder's deployed Lambda revision is not yet discoverable from here
			environment: 'production',
			origin: process.env.CINDER_PRODUCTION_ORIGIN || 'https://cinder.ink',
			mode: deep ? 'deep' : 'quick',
			widths: deep ? [320, 375, 402, 440, 768, 1440, 1920, 2560] : [375, 1440],
			colorSchemes: deep ? ['light', 'dark'] : ['light'],
			accessibilityModes: [],
			routeCount: 1,
			engine: 'chromium',
			passed,
			failed,
			skipped,
			durationMs,
			result: failed === 0 && passed > 0 ? 'pass' : 'fail',
			assertions: this.results
				.map((r, i) => ({ ...r, i }))
				.filter((r) => r.status !== 'passed')
				.map((r) => `production-surface-${r.i}-${r.status}`),
			realDevice: false,
			dirtyTreeDigest: (git(['status', '--porcelain']) || '') === '' ? 'clean' : 'dirty',
			observedAt: new Date().toISOString()
		};

		const dir = path.join(process.cwd(), '.remember', 'uxqa');
		fs.mkdirSync(dir, { recursive: true });
		const target = path.join(dir, 'evidence.json');
		const tmp = path.join(dir, `.evidence.json.tmp-${process.pid}`);
		fs.writeFileSync(tmp, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
		fs.chmodSync(tmp, 0o600);
		fs.renameSync(tmp, target);
	}
}
