# Icebox — deferred work for the next agent

Things Matt explicitly chose to defer. Not bugs, not blockers — future work.

## Repo rename: blip → cinder
- The product brand is **Cinder**; `blip` remains the repo slug, the `blip.uxuiai.org` subdomain, the CloudFormation stack name, and the S3 bucket (`blip-site-...`).
- GitHub renames keep old links working via automatic redirects, so a rename is safe whenever Matt wants.
- **Trigger:** do this when Matt commits to the Cinder brand (e.g. grabs a cinder domain — cinder.ink / cinder.email / cindernote.com were available on 2026-07-01). Until then, leave the slug; churn isn't worth it.
- If renaming: `gh repo rename cinder`, update `git remote set-url origin`, update `cd blip` → `cd cinder` in README + docs, optionally rename the local dir and the SAM stack/bucket (stack/bucket rename = a destroy+recreate, so probably leave those as `blip-*` forever).

## Light / dark mode (honor system preference like Matt's other apps)
- Cinder is currently dark-only (the "vault" aesthetic). Matt wants `prefers-color-scheme` support matching his other apps.
- **Where:** `src/app.css` defines the palette in an `@theme` block (`--color-ink`, `--color-ink-soft`, `--color-line`, `--color-mist`, `--color-ghost`, `--color-ember`, `--color-ember-soft`). A light theme means a second token set under `@media (prefers-color-scheme: light)`.
- **Watch:** button contrast — ember (#ff6b4a) + black text is 7:1 (AAA) on dark; re-check the ratio on a light background. The merkaba's inner cut-out uses `--color-ink` (see `src/lib/ui/Merkaba.svelte`) so it'll follow the token automatically if tokens are themed correctly.
- Keep the ember accent constant across themes; only the neutrals flip.

## Android / TWA (already documented as fast-follow)
- PWA (`@vite-pwa/sveltekit`) → Bubblewrap TWA → Play Store. See the design spec.
- **Critical:** `/.well-known/assetlinks.json` must resolve BEFORE the CloudFront SPA fallback (a `CustomErrorResponses` 403/404 → /200.html catch-all will otherwise swallow it). There's a comment marking this in `template.yaml`.
