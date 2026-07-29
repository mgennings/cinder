// The one place the UXQA matrix is declared for this repository, imported by
// BOTH the live surface spec and the evidence reporter.
//
// It existed as two copies: the spec looped over one hardcoded width list and
// the reporter reported another. They agreed by hand, which means a future
// edit to either one produces evidence that claims a width the run never
// opened — exactly the overstatement the runner exists to catch, and the one
// thing it cannot catch, because it validates the claim against the manifest
// rather than against the run.
//
// Deep mode is the complete declared matrix from .uxqa.json. Quick mode is the
// plan's smoke coverage: 375 and 1440.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo_root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(path.join(repo_root, '.uxqa.json'), 'utf8'));

export const DEEP = process.env.CINDER_UXQA_MODE === 'deep';
export const WIDTHS = DEEP ? manifest.coverage.widths : [375, 1440];
export const COLOR_SCHEMES = DEEP ? manifest.coverage.colorSchemes : ['light'];
export const ENGINES = manifest.coverage.engines;
