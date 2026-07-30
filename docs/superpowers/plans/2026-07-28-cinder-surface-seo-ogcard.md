# Cinder Surface, SEO, and Social Card Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every public Cinder surface truthful to a crawler and to an unfurler without weakening one privacy promise, and replace the two social cards with a generated, first-party, brand-correct set that a platform can crop without destroying.

**Architecture:** Nothing new is introduced. Indexing control moves from a `robots.txt` `Disallow` (which cannot carry a `noindex` and does not stop URL-only indexing) to an `X-Robots-Tag` emitted by the CloudFront function that already rewrites `/n/`. The social cards move from two hand-made rasters with no source to a third render target inside `scripts/build-brand.py`, which already lifts the mark geometry from `static/brand/cinder-mark.svg` and outlines Inter with fontTools so no downstream surface needs a font. `scripts/build-social-shell.mjs` grows a file shell beside its note shell. The stats surface gets a line-height chosen against real descender depth and an empty state that reads as a working guarantee rather than a broken page.

**Tech Stack:** SvelteKit 5, TypeScript, CloudFront Functions (cloudfront-js-2.0), AWS SAM, Python 3 with fontTools and rsvg-convert, Vitest, Node test runner, Playwright

## Global Constraints

- Preserve every existing Cinder promise exactly: one server delivery attempt, the derived 4 MiB ceiling, structural delete-before-delivery, read-once destruction, no IAM widening, and the current CSP, HSTS, `frame-ancestors`, and `Permissions-Policy` headers on all four aliases.
- No social card may ever contain note content, a filename, a recipient, a sender, a locator, a MIME string, or any value derived from a payload. The card set is a fixed literal table in a build-time script that reads no runtime input.
- No external font, no CDN, no remote image. The live CSP is `default-src 'none'` with `img-src 'self' data:` and `font-src 'self'`, and `frame-ancestors 'none'` at the edge. Every card asset is first-party and static.
- An unfurl is an automated GET. No change may make a GET to `/n/{id}` or `/f/{locator}` consume, mutate, or reveal anything. Burn stays a POST behind a human action.
- Do not add a dependency, a chart library, a shared dashboard framework, or an analytics call anywhere.
- Do not touch `playwright.live-readonly.config.ts`, `tests/live/production-surface.spec.ts`, `package.json`, or `scripts/uxqa-evidence-reporter.mjs`. Another lane owns those.
- Do not deploy or push a deploy-wired branch until the applicable gate is open. Never place a secret, capability, grant, locator, or private contact in a file, argv, shell history, log, commit, or this plan.
- American English everywhere, including comments and commit messages. The brand string is `experience Architects`. `uxuiai.org` is the product organization; `ux-ui.ai` is the consultancy and never appears on a product surface.

---

## Audit findings

Every number below was measured on 2026-07-28 from rendered pixels at 320, 375, 440, 768, and 1440 CSS pixels in both color schemes, plus 200 percent browser text at 320, against live `https://cinder.ink` and live `https://stats.cinder.ink`. Contrast was computed from an ink and plate screenshot pair: the plate is the identical render with every glyph forced transparent, so any pixel that differs is a glyph and any pixel that matches is background. That is the only method that sees a background image, which `getComputedStyle().backgroundColor` cannot (`.notes/GOTCHAS.md`).

**Instrument warning for the implementer.** A first pass that picked "the pixel farthest in luminance from the ground" inside an element's bounding box reported the light-mode `Reveal note` label at **3.05:1**. That number is false. The button has rounded corners, so the white card behind it sits inside the rectangle and was selected as the ink. The difference-mask method reports the same label at **6.08:1**, which is correct. Do not reintroduce the luminance-extreme heuristic.

### Severity summary

| Severity | Count |
|---|---|
| Critical | 2 |
| High | 6 |
| Medium | 11 |
| Low | 5 |
| **Total** | **24** |

### Critical

| # | Finding | Measured before-value | Evidence |
|---|---|---|---|
| C1 | The reader routes carry no enforceable `noindex`. The `noindex` meta is injected client-side, and the served shell has none, so a crawler that does not run JavaScript never sees it. `robots.txt` `Disallow` is the only layer, and a `Disallow` cannot deliver a `noindex`: it prevents the fetch, which is exactly what prevents the directive from ever being read, while leaving the URL indexable from any external link. | `curl https://cinder.ink/n/<id>` returns **0** occurrences of `name="robots"`. Same for `/f/<locator>` and `/200.html`. No `X-Robots-Tag` on any response. | `static/robots.txt`, `template.yaml:568-611`, live response headers |
| C2 | A sender-controlled MIME string reaches `new Blob()`. `type: typeof meta.type === 'string' ? meta.type : ''` is validated by nothing but a `typeof` check, and is passed straight into the blob's type. It is inert only because `a.download = f.name` on the next lines forces a save. The moment any surface renders rather than saves, a sender-supplied `text/html` executes at `blob:https://cinder.ink/...` with cinder.ink's own origin, where it can read the `cinder.sender-status.v1` tokens. | Verified in source. `default-src 'none'` blocks framing today, so the whole guarantee currently rests on one attribute. | `src/lib/crypto/file-crypto.ts:409-410`, `src/routes/f/[locator]/+page.svelte:110-111`, `vite.config.ts:77` |

### High

| # | Finding | Measured before-value | Evidence |
|---|---|---|---|
| H1 | Soft 404. Every unresolved path returns HTTP **200** with an **empty `<title>`**, because CloudFront maps 403 and 404 to 200 with `/200.html`. A crawler sees an indexable, titleless page at every junk URL. | `GET /this-route-does-not-exist` returns `200`, `document.title` is `""`, `h1` is `404`. | `template.yaml:634-641` |
| H2 | `/account` and `/pro/done` are fully indexable: HTTP 200, no canonical, and no robots directive in the served shell. `/signin` and `/signup` do set `noindex`, but client-side only, so a non-JS crawler sees neither. | `/account` served title `""`, canonical `null`, robots `null`. Client-side title resolves to `Your Cinder account`, h1 `An account, and nothing else`. | live fetch, `src/routes/account/+page.svelte` |
| H3 | `/security` and `/field-notes` never override `og:title` or `twitter:title`, so both share as the generic homepage card while their real `<title>` differs. Every prerendered subpage also emits `og:url` **twice**. | `/security`: `<title>` is `How private is Cinder, really?` but `og:title` is `Cinder — an encrypted note or file retrieved once`. `og:url` = `['https://cinder.ink', 'https://cinder.ink/security']`. | live fetch, `src/app.html:19-32` |
| H4 | The primary `og.png` does not carry the brand mark, and it has a near-full-width seam. The shipped figure is almost certainly a screen capture of the ambient `Merkaba.svelte` mid-rotation, which is the exact defect `scripts/build-brand.py` already records as fixed for the favicons. The og card is the last place it lives. | True mark (`cinder-mark.svg`) vertical-mirror overlap **99.9%**. og.png figure: **14.0%**. Horizontal discontinuity at **y=399 across 1,139 of 1,200 columns**, mean luminance step **14.28**. Ink distribution: top third 4.7%, middle third **90.7%**, bottom third 4.6%. A 1:1 center crop keeps 71.1%; a 4:5 crop keeps **52.8%**. | `static/og.png`, `static/brand/cinder-mark.svg` |
| H5 | `/f/{locator}` has no card of its own. The CloudFront function rewrites only `/n/`, so a file link falls through to `/200.html` and unfurls with the generic marketing card and the generic title. | `/f/<locator>` served `og:image` = `https://cinder.ink/og.png`, `og:title` = the homepage title. | `template.yaml:596`, `scripts/build-social-shell.mjs` |
| H6 | On `stats.cinder.ink` the headline's two lines physically touch. `line-height: 0.86` against `clamp(3rem, 12vw, 8rem)` puts zero painted pixels between the descenders of line one and the ascenders of line two, at every width, in both schemes. | Painted ink gap between lines = **0px** at 320, 375, and 1440 in dark and light. Em-box overlap **17.7px** at 320 and 375, **44.9px** at 1440. `font-size` 48px / `line-height` 41.28px / `letter-spacing` -3.6px at 320; 128px / 110.08px / -9.6px at 1440. | `stats/site/stats.css:45-48` |

### Medium

| # | Finding | Measured before-value | Evidence |
|---|---|---|---|
| M1 | A horizontally scrollable `<pre>` on `/field-notes` is not keyboard reachable. WCAG 2.1.1 requires a scrollable region to be focusable. | `scrollWidth` **574px** against `clientWidth` **278px** at 320. `overflow-x: auto`, `tabindex` **null**, no `role`, no `aria-label`. | `/field-notes`, live |
| M2 | `Inter` is declared and never shipped. There is no `@font-face` and no font file anywhere in the repo, so every rendered surface falls back to `ui-sans-serif` / `system-ui` for anyone without Inter installed locally. | `grep -rn "@font-face" src/ static/` returns nothing. `find` for `*.woff*`, `*.ttf`, `*.otf` returns nothing. Computed `font-family` on `body` is `Inter, ui-sans-serif, system-ui, ...`. | `src/app.css:52` |
| M3 | The designed focus ring is not applied to the wordmark link or to inline prose links. Those fall back to Chrome's default 1px `#005FCC`. | Designed ring measures **6.25:1** dark and **3.52:1** light (`.notes/GOTCHAS.md`). The fallback measures **3.25:1** at **1px** on the vault floor. Affected: wordmark `<a>` on every reader page, and inline links on `/signin`, `/signup`, `/account`, `/security`. | live focus traversal |
| M4 | Three hosts serve identical content with HTTP 200. Only `www.cinder.ink` redirects. | `cinder.ink` 200, `www.cinder.ink` **301** to `https://cinder.ink/`, `cinder.uxuiai.org` **200**, `blip.uxuiai.org` **200**. All three 200 hosts serve `rel="canonical" href="https://cinder.ink/"` and an identical `robots.txt`. | live fetch, `template.yaml:614-621` |
| M5 | `og.png` is served with **no `Cache-Control`**. `aws s3 sync` sets none, and only the extensionless HTML aliases get an explicit `max-age`. A replaced card can stay stale in a platform's unfurl cache indefinitely. | Live response headers on `/og.png` contain `Content-Type`, `Content-Length`, `ETag`, and no `Cache-Control`. | `scripts/deploy-frontend.sh:16-30` |
| M6 | The default card declares no `og:image:width`, `og:image:height`, or `og:image:alt`. Only the note route declares them. `og-note.png` is **687,687 bytes**, above the practical thumbnail budget of several messaging clients. | `/`, `/security`, `/field-notes`, `/pro`, `/f/*`: all three fields `null`. `og.png` 460,193 bytes; `og-note.png` 687,687 bytes. | `src/app.html:24-32` |
| M7 | `static/sitemap.xml` carries a hardcoded `lastmod` of `2026-07-28` on all four URLs. It will rot silently the first time a page changes. | Four `<url>` entries, one literal date. | `static/sitemap.xml` |
| M8 | The live stats arrival page reserves two large empty bands. `.vault-artifact` is `min-height: 28rem` with `align-content: space-between` and exactly three children, so the space between them is empty by construction. This is the shape of cross-dashboard Finding 1 and Finding 5. | Gaps of **97px and 97px** at 320, 375, and 440. **296.9px and 296.9px** at 768. **304.6px and 304.6px** at 1440. Artifact height 448px at mobile, 863.2px at 1440. | `stats/site/stats.css:56`, live |
| M9 | When `/api/metrics` fails, `.metric-grid` renders as a completely empty reserved box. This is the true form of "shows no analytics whatsoever" in this repo. | **288 x 320** at 320 wide and **1280 x 320** at 1440 wide, `childCount` **0**, `aria-busy` `false`, with only a 12px status line as signal. | `stats/site/stats.css:79`, `stats/site/dashboard.js` |
| M10 | The metric value scale is monumental and is applied to word values as well as numerals. | `no samples` renders at **32px** (320 to 440), **53.76px** (768), **64px** (1440), against its own `h2` label at a constant **16px**. At 1440 the word value is **4x** its label and the headline is 128px. | `stats/site/stats.css:84` |
| M11 | `stats/test-layout.mjs` passes on the colliding headline. It asserts page overflow, clipped text, 48px targets, and contrast, and nothing about line-height, reserved-but-empty bands, or value type scale. | All assertions in the file are at lines 160, 161, 162, 209, 215-227. None measures inter-line ink. | `stats/test-layout.mjs` |

### Low

| # | Finding | Measured before-value | Evidence |
|---|---|---|---|
| L1 | `<meta name="text-scale" content="scale">` is not a standard meta name and does nothing. | Present in the served head of every page. | `src/app.html:6` |
| L2 | `og:url` is `https://cinder.ink` with no trailing slash while `rel="canonical"` is `https://cinder.ink/`. Two spellings of the same page. | Both present in the same served head. | `src/app.html:25` |
| L3 | The deploy loop publishes an extensionless `/note` alias, because `note.html` matches `build/*.html`. It is a reachable duplicate of the note shell at a path nothing links to. | The loop skips only `index` and `200`. | `scripts/deploy-frontend.sh:22-30` |
| L4 | `overflow-wrap: anywhere` on `.metric-card > strong` never fires. The cross-dashboard findings file reads it as a tell that words were already breaking mid-word. Measured against the real value vocabulary, nothing overflows at any width in either scheme. | `scrollWidth == clientWidth` on all four cards at 320, 375, 440, 768, and 1440, both schemes. Right-edge overflow **-1px** in every case. Values exercised: `1,483`, `0`, `no samples`, `215 ms`. | live local render of `stats/site` |
| L5 | The note shell emits `og:title` and `og:image` **twice** after hydration, because `scripts/build-social-shell.mjs` writes them into the static shell and `src/routes/n/[id]/+page.svelte` adds them again. The values are identical, so nothing is currently wrong, but two sources for one tag is a drift waiting to happen. | `og:title` = `['Someone left you a one-time note · Cinder', 'Someone left you a one-time note · Cinder']`. | live fetch |

### What was verified and is holding

These were checked because a prior pass fixed them or because a promise depends on them. They are all still good, and the tasks below must not regress them.

| Check | Result |
|---|---|
| Horizontal overflow, every route, 320 / 375 / 440 / 768 / 1440, both schemes | **0px** everywhere. The prior `/f/` sideways-scroll fix is holding. |
| Text contrast, 330 glyph-and-ground pairs measured from rendered pixels | **0 below AA.** The prior light-mode button fix is holding: `Reveal note` measures **6.08:1**, `Create one-time link` measures **5.30:1** light and **5.36:1** dark. |
| Tightest text ratio on the site | `.link-quiet` light at 320 wide: **4.64:1** against a 4.5 requirement. Margin is 0.14, so any darkening of the light card or lightening of `--color-mist` breaks it. |
| 200 percent browser text at 320, both schemes, eight routes | Page overflow **0px** on every route. No content or function lost. Headings wrap hard (the note gate h1 sets to five lines) but nothing is cut off. |
| Reduced motion | **0** running animations on six routes, and both ambient layers still painted with `opacity: 1` and `animation: none`. The `z-index: -1` disappearing-glow trap in `.notes/GOTCHAS.md` is fixed and holding. |
| Forced colors | Text, borders, and controls all map to system colors. No information is lost. The ember button loses its fill and reads as an outlined control, which is correct behavior. |
| Security headers, all four aliases | `Strict-Transport-Security`, `X-Frame-Options: DENY`, `Content-Security-Policy: frame-ancestors 'none'; base-uri 'none'; form-action 'none'`, `X-Content-Type-Options`, `Referrer-Policy: no-referrer`, and `Permissions-Policy` present and identical on `cinder.ink`, `www.cinder.ink`, `cinder.uxuiai.org`, and `blip.uxuiai.org`. |
| Stats contrast, both schemes, 12 selectors | **0 below AA.** Tightest are `.eyebrow` light **5.02:1**, `window-control` pressed light **5.22:1**, and `.metric-card > strong` light **5.85:1**. |

### Does anything cause an unfurler to render sender-supplied bytes at our origin?

**No. Verified, and the answer is currently clean on every route.** Recorded here because it is the sharper form of the link-preview question and because Task 2 must not break it.

- `/n/{id}` is served the static `build/note.html`. Its `og:*` values are compile-time literals substituted by a fixed `Map` in `scripts/build-social-shell.mjs`. There is no template interpolation and no runtime value.
- `og:url` on the note shell is the literal `https://cinder.ink`. It does not echo the locator. Grep of the served shell for the requested 22-character id returns **0** occurrences.
- The note and file routes are `prerender = false; ssr = false`, so the served body is empty. No payload byte reaches the HTML a crawler receives.
- The decryption key lives in the URL fragment, which by definition is never sent in an unfurler's GET.
- An unfurl cannot consume a note. `burnNote(id)` is called only inside `reveal()`, which is bound to the button's `onclick`. The route's only `$effect` parses `page.url.hash`. A GET, with or without JavaScript, cannot reach the burn.
- No route derives a title, description, or image URL from a note, an envelope, a filename, or a MIME string.
- The sender-status check added by the concurrent note-status lane is a read-only projection that fires only when a local token exists, so an unfurler never triggers it. Task 2 adds a test that pins this.

The one place a sender-supplied string becomes a rendering instruction is C2, and it is not reachable from an unfurl today. It becomes reachable the moment any surface renders rather than saves the blob.

### stats.cinder.ink against the cross-dashboard findings

Measured against `/Users/matthewgennings/Developer/messiah/.superpowers/sdd/2026-07-28-global-stats-explorer/CROSS-DASHBOARD-RENDER-FINDINGS.md`.

| Cross-dashboard finding | cinder verdict | Measured basis |
|---|---|---|
| Finding 1, dead vertical band inside every value card | **Partially exhibits.** `.metric-grid { min-height: 20rem }` is **inert** in the populated state: real content height is 1224px at 320, 709px at 768, and 885px at 1440, all far above the 320px floor. The band between label and value is a constant **24px**, which is the deliberate `margin-block: 1.5rem`, not empty reserved space. Cinder's cards carry a chart and a table, so they are dense where metamatt's are not. The finding **does** appear in the failure state, where the same `min-height` renders a fully empty 288x320 or 1280x320 box with zero children (M9). | Populated and failed renders at three widths, both schemes |
| Finding 2, numeric display scale applied to word values | **Partially exhibits.** The aesthetic half is real: `no samples` sets at 64px against a 16px label at 1440 (M10). The overflow half is **not** real here. `overflow-wrap: anywhere` never fires with the actual value vocabulary at any width in either scheme (L4). The findings file reads that property as a suppressed symptom; measured, it is precautionary. | `scrollWidth == clientWidth` on all four cards, five widths, both schemes |
| Finding 3, headline's two lines collide | **Exhibits, and it is the worst measured defect on the stats surface.** Zero painted pixels between the two lines at every width and scheme (H6). | Ink and plate difference mask over the headline box |
| Finding 4, large unused vertical space below the content | **Does not exhibit.** Dashboard content exceeds the viewport at every width measured, so there is no unused tail. | `main` bottom edge below the viewport at 320, 375, 440, 768, and 1440 |
| Finding 5, `.live-field` repeats Finding 1 | **Exhibits under a different selector.** Cinder has no `.live-field`. Its analog is `.vault-artifact`, and the mechanism is identical: `min-height` plus `align-content: space-between` over three children (M8). The consequence is decorative rather than informational, because the element is `aria-hidden="true"`. | Live arrival page, five widths, both schemes |

**Constellation recommendation.** One shared correction, five local ones.

- **Finding 3 is the one to correct once, centrally.** The exact declaration `font-size: clamp(3rem, 12vw, 8rem); line-height: 0.86` is a literal copy across cinder, metamatt, uxuiai, and ux-ui.ai. It produces a measurable, identical, objectively wrong result (zero ink between lines) wherever the headline sets to more than one line. A single agreed value, chosen against real descender depth and verified by the same ink-gap measurement in each repo, is the correct shared fix. That is a shared **rule with a per-repo proof**, not a shared stylesheet.
- **Findings 1, 2, 4, and 5 are repo-local.** The CSS habit is shared but the selectors, the child counts, the content density, and the consequences all differ. Cinder's cards are dense and its dead band only appears on failure; metamatt's appear always. A single shared correction would either overfit metamatt or under-fix cinder. Correct the habit in each repo against that repo's measured numbers.
- **Do not build a shared dashboard package.** The findings file already forbids it and the measurements support that: the four surfaces diverge more than they agree.
- **Correct the findings file's `overflow-wrap` inference in the same pass.** It is stated as evidence of a suppressed symptom, and in cinder it is not. Leaving it stands up a false premise for the other five repos.

---

### Task 1: Make the Reader Routes Unindexable by a Header Rather Than a Hope

**Files:**
- Modify: `template.yaml:568-611` (the `CinderViewerRequest` function and a new response-headers association)
- Modify: `static/robots.txt`
- Test: `api/test/infrastructure.test.mjs`
- Test: `tests/live/` is owned by another lane. Add live proof to Task 7 instead.

**Interfaces:**
- Any request whose URI begins with `/n/` or `/f/` receives `X-Robots-Tag: noindex, nofollow, noarchive, nosnippet, noimageindex`.
- `/n/` continues to rewrite to `/note.html`. `/f/` newly rewrites to `/file.html`.
- No response body, status code, or existing security header changes.

**This task carries a posture decision. Do not resolve it silently.** Today `robots.txt` disallows `/n/` and `/f/`. That blocks the fetch, which is precisely what stops any `noindex` from ever being read, while leaving the URL indexable from an external link. It also means the compliant unfurlers Matt cares about (Slack, Twitter, LinkedIn, Facebook) do not fetch the note shell at all, so the "someone left you a note" card he wants improved is probably not rendering on those platforms today. Removing the `Disallow` and enforcing `noindex` by header gets both properties. It is a real change in posture and it belongs to Marlin and Matt, not to the implementer. Build both halves; ship the header first; hold the `robots.txt` narrowing behind the gate in the Marlin section.

- [ ] **Step 1: Write the failing infrastructure assertions**

Assert that the viewer-request function rewrites `/f/` to `/file.html` and leaves every other URI alone, and that a response-headers policy attaches `X-Robots-Tag` with all five directives to the reader paths. Assert the existing `Strict-Transport-Security`, `X-Frame-Options`, `Content-Security-Policy`, `X-Content-Type-Options`, `Referrer-Policy`, and `Permissions-Policy` values are byte-identical to their current values, so this task cannot loosen a header while adding one.

- [ ] **Step 2: Run and confirm failure**

```bash
node --test api/test/infrastructure.test.mjs
```

- [ ] **Step 3: Add the reader-path cache behavior and its headers policy**

Add a `ReaderHeadersPolicy` that copies `SiteHeadersPolicy` exactly and adds the `X-Robots-Tag` custom header. Add two cache behaviors, `/n/*` and `/f/*`, above the default behavior, both pointing at `s3-site` with the same `CachePolicyId`, the same `FunctionAssociations`, and the new `ResponseHeadersPolicyId`.

```
X-Robots-Tag: noindex, nofollow, noarchive, nosnippet, noimageindex
```

Extend the viewer-request function to route the file reader to its own shell:

```js
if (request.uri.indexOf('/n/') === 0) request.uri = '/note.html';
if (request.uri.indexOf('/f/') === 0) request.uri = '/file.html';
```

The `assetlinks.json` warning already in `template.yaml` applies here too: these behaviors must sit **above** the SPA fallback or they will never match.

- [ ] **Step 4: Validate and commit the edge slice**

```bash
node --test api/test/infrastructure.test.mjs
sam validate --lint
git add template.yaml api/test/infrastructure.test.mjs
git commit -m "🔒 feat(seo): refuse indexing of reader routes at the edge" -m "- serve X-Robots-Tag where a client-side meta cannot reach a crawler" -m "- route the file reader to its own shell" -m "- leave every existing security header byte-identical"
```

---

### Task 2: Give Every Route an Honest Title, Canonical, and Card

**Files:**
- Modify: `src/app.html:16-44`
- Modify: `src/routes/security/+page.svelte`
- Modify: `src/routes/field-notes/+page.svelte`
- Modify: `src/routes/account/+page.svelte`
- Modify: `src/routes/pro/done/+page.svelte`
- Modify: `src/routes/f/[locator]/+page.svelte`
- Modify: `src/routes/n/[id]/+page.svelte`
- Modify: `src/routes/+error.svelte` (create if absent)
- Modify: `static/sitemap.xml`
- Test: `src/lib/head.test.ts` (new)

**Interfaces:**
- Every route emits exactly one `og:title`, one `og:url`, one `og:image`, one `twitter:title`, one `twitter:image`, and one `rel="canonical"`.
- `og:url` and `rel="canonical"` are the same string on every route, always with the trailing slash form used by the sitemap.
- `/account`, `/pro/done`, `/signin`, and `/signup` declare `noindex` and no canonical.
- The error route declares a real `<title>`.

- [ ] **Step 1: Write the failing head test**

Read every prerendered file in `build/` and assert, per file: exactly one of each tag above, `og:url` equal to `canonical`, a non-empty `<title>`, and `og:image` drawn from a set of exactly three literal URLs. Assert that no `<meta>` content in any built file contains a `%`, a `{`, or any substring of a route parameter, so a template placeholder can never ship into a card. Assert the sitemap contains only routes that are both prerendered and not `noindex`.

- [ ] **Step 2: Run and confirm failure**

```bash
pnpm build && pnpm test -- src/lib/head.test.ts
```

- [ ] **Step 3: Remove the duplicate source of truth in the shell**

`src/app.html` currently hardcodes the homepage's `og:title`, `og:description`, `og:url`, `twitter:title`, and `twitter:description`, and every page then appends its own, which is what produces two `og:url` tags on `/security`, `/field-notes`, and `/pro` and the stale title on the first two. Move the homepage values into `src/routes/+page.svelte`'s `<svelte:head>` and leave only the values that are genuinely global in the shell: `og:type`, `og:site_name`, the icon and manifest links, and the JSON-LD block. Delete the nonstandard `<meta name="text-scale">` (L1).

Add `og:image:width`, `og:image:height`, and `og:image:alt` beside every `og:image`, and keep `og:url` in the trailing-slash form (L2).

- [ ] **Step 4: Give the remaining routes their own head**

`/security` and `/field-notes` get an `og:title` and `twitter:title` matching their real `<title>`. `/account` and `/pro/done` get `<meta name="robots" content="noindex, nofollow" />` and no canonical. `/f/{locator}` gets the file card and the file title, matching the note route's existing shape. Create `src/routes/+error.svelte` with a real title, a `noindex`, and a way forward, so the 404 is a direction rather than a dead end.

- [ ] **Step 5: Make the sitemap generated rather than dated by hand**

Replace the four hardcoded `lastmod` values with build-time generation from each prerendered route's source mtime (M7). Keep the file at `static/sitemap.xml` if generation writes it before `vite build` copies static, or emit it into `build/` after. Either is fine; a hardcoded date is not.

- [ ] **Step 6: Validate and commit the head slice**

```bash
pnpm build
pnpm test -- src/lib/head.test.ts
pnpm check
git add src/app.html src/routes static/sitemap.xml src/lib/head.test.ts
git commit -m "🏷️ fix(seo): give every route one honest title and canonical" -m "- stop the shell and the page from both claiming og:url" -m "- mark the account and purchase surfaces noindex" -m "- give the error route a title and a way forward"
```

---

### Task 3: Turn the Soft 404 Into a Real One

**Files:**
- Modify: `template.yaml:634-641`
- Test: `api/test/infrastructure.test.mjs`

**Interfaces:**
- An unresolved path returns HTTP **404** with the SPA shell body, so the page still renders and still offers a way forward.
- A resolved path is unaffected.
- The 403 mapping that makes CloudFront's private-bucket origin work stays, because removing it would break every real page.

- [ ] **Step 1: Add the failing assertion**

Assert `CustomErrorResponses` maps 404 to `ResponseCode: 404` while still serving `/200.html`, and that the 403 entry still maps to 200 so the OAC origin keeps working for real keys.

- [ ] **Step 2: Run and confirm failure**

```bash
node --test api/test/infrastructure.test.mjs
```

- [ ] **Step 3: Separate the two error codes**

They are conflated today because a private S3 origin answers 403 for a missing key when the caller cannot list, which is the same fact `api/src/s3-errors.mjs` already turns on. Keep 403 mapped to 200 (it is how a legitimate SPA route resolves) and map 404 to 404. Add a comment naming that reason, because the next reader will otherwise "simplify" them back together.

- [ ] **Step 4: Validate and commit**

```bash
node --test api/test/infrastructure.test.mjs
sam validate --lint
git add template.yaml api/test/infrastructure.test.mjs
git commit -m "🐛 fix(seo): answer 404 for a path that does not exist" -m "- stop every junk URL from returning an indexable 200" -m "- keep the 403 mapping the private origin depends on"
```

---

### Task 4: Generate the Social Cards From the Brand Source

**Files:**
- Modify: `scripts/build-brand.py`
- Modify: `scripts/build-social-shell.mjs`
- Add: `static/og.png`, `static/og-note.png`, `static/og-file.png` (all generated)
- Test: `scripts/test-brand.py` (new) or a Node test asserting byte-identity

**Interfaces:**
- `python3 scripts/build-brand.py` stays a dry run; `--apply` writes.
- New function `social_card(kind)` where `kind` is one of exactly `'primary' | 'note' | 'file'`. It takes no other input.
- Output: three 1200x630 PNGs rendered by `rsvg-convert`, the renderer this script already uses.

#### The card design

**Signature.** One system owns the card: the merkaba held in a technical grid, with the ember core as the only lit thing. This is Cinder's own geometry, not an imported look. `static/brand/cinder-mark.svg` says the 24 degree offset is load-bearing and must not be cleaned up, so the card lifts the polygon points verbatim the way `wordmark()` already lifts them, rather than redrawing them.

**Why the current cards fail and what replaces them.** The primary card carries a figure that is 14.0% mirror-symmetric where the real mark is 99.9%, so it is not the brand mark. It puts 90.7% of its ink in the middle third and tears across 1,139 columns at y=399. The note card is a phone mockup on a cyan and violet wave field, which is neither Cinder's palette (one ember channel, no cyan) nor first-party (no source, no reproducibility, 687KB), and its in-phone copy is illegible at the sizes platforms actually render. Both are replaced by one generated system.

**Canvas and crop safety.** 1200 x 630 (1.91:1). Platforms crop: a 1:1 center crop keeps 630 x 630, a 4:5 crop keeps 504 x 630. **Every element that carries meaning lives inside the centered 630 x 630 square with a 45px inner margin, giving a 540 x 540 live area.** The signal terrain runs the full 1200 width and is the only thing allowed outside the safe square, so a crop removes art and never information. The measured before-value for this rule is the current 52.8% ink retention at 4:5; the target is that a 4:5 crop retains 100% of the type and the mark.

**Type scale, set against the sizes platforms actually render.** Slack renders an unfurled card near 360 CSS pixels wide, Twitter's `summary_large_image` near 500, and a message-client thumbnail as low as 300. At 300px the scale factor is 0.25. **No type on the card is smaller than 40px**, so nothing renders below 10px at the worst crop.

| Role | Size | Token | Treatment |
|---|---|---|---|
| Eyebrow | 40px, `--font-mono`, letter-spacing 0.16em, uppercase | `--color-mist` `#a69d93` | One line, a state word, never a claim the system cannot prove |
| Headline | 64px, Inter SemiBold outlined, tracking -0.01em | `--color-body` `#f1ece4` | Two lines maximum, `line-height` 1.12, chosen against measured descender depth, never 0.86 |
| Support | 40px, Inter Regular outlined | `--color-mist` `#a69d93` | One line, a literal fact |
| Mark | 260px square | ember stroke `#ff6b4a`, core `#ff8f73` | Lifted from `cinder-mark.svg`, geometry untouched |
| Terrain | full width, behind everything | `--color-line` `#2a231e` grid, one ember trace at `--color-ember-deep` `#d94a2a` | Decorative only, croppable |

**Color tokens, read from `src/app.css` `@theme`, not invented.** Ground `--color-ink` `#0d0b0a`. Panel `--color-ink-soft` `#151210`. Grid `--color-line` `#2a231e`. Ink `--color-body` `#f1ece4`. Muted `--color-mist` `#a69d93`. Ember `--color-ember` `#ff6b4a`, `--color-ember-soft` `#ff8f73`, `--color-ember-deep` `#d94a2a`. Cinder has exactly one electric channel. Do not import `cyberpunk-craft`'s example cyan, violet, and magenta; the skill's own instruction is to replace its placeholder palette with the product's tokens.

**Appearance.** The card commits deliberately to the dark register as a single instrument panel, which `cyberpunk-craft` permits explicitly. A social card is a fixed raster and cannot respond to a viewer's scheme, so committing is honest and a washed-out compromise is not. The mark's light variant already exists for surfaces Cinder does not control.

**No fake telemetry.** The card may carry only literals that are true in this repo: `AES-256-GCM`, `one retrieval`, `the key stays in the fragment`, `under 4 MiB is free`. No invented counts, no sequence numbers, no `VERIFIED` badge.

**How the three cards differ, and only how.** Same canvas, same grid, same tokens, same type scale, same mark geometry, same composition. Three differences and no others, so they read as one system in a thread:

| | Primary (`/`, and every marketing route) | Note (`/n/*`) | File (`/f/*`) |
|---|---|---|---|
| Eyebrow | `ENCRYPTED IN YOUR BROWSER` | `ONE-TIME NOTE` | `ONE-TIME FILE` |
| Headline | `a note or a file, retrieved once` | `someone left you a note` | `someone left you a file` |
| Support | `the key never touches the server` | `revealing it removes Cinder's copy` | `one delivery, then it is gone` |
| Mark state | core at rest, terrain trace running both directions | core lit, one trace running to the right edge | core lit, one trace running to the right edge |

The per-note card is the same instrument showing a different state. It is not a different picture. Nothing in it is derived from the note.

#### Non-negotiable: the card's content is a Cinder literal, enforced in code

Stated as an intention this is worth nothing. It is enforced four ways:

1. `social_card(kind)` accepts one argument from a three-member literal set and reads no file, no argv, no environment, and no network. The card text lives in a `CARDS` dict of frozen literals at the top of the script.
2. The cards are **build-time** artifacts. There is no runtime code path from a note, an envelope, a filename, or a MIME string to any pixel, because nothing renders a card at request time.
3. A test asserts the three shipped PNGs are byte-identical to a fresh render, the same contract `build-brand.py` already states as "fix the SVG or this script; never hand-edit a PNG." A hand-edited or payload-influenced card fails the build.
4. Task 2's head test asserts every `og:image` and `twitter:image` in every built file is one of exactly three literal URLs, and that no meta content carries a template placeholder.

- [ ] **Step 1: Write the failing card tests**

Assert the three PNGs exist at 1200x630, that a fresh render is byte-identical to the shipped file, that `social_card` rejects any `kind` outside the literal set, and that the rendered figure's vertical-mirror overlap is above 99% (the current card measures 14.0%, so this assertion fails today and pins the defect).

- [ ] **Step 2: Run and confirm failure**

```bash
python3 scripts/build-brand.py
node --test scripts/test-brand.test.mjs
```

- [ ] **Step 3: Compose the card and render it**

Build the card as an SVG string in the script, reusing the two helpers that already exist: lift the mark's `<g>` and `<circle>` verbatim from `cinder-mark.svg` the way `wordmark()` does, and outline the headline and support text with the existing fontTools path so the SVG needs no font at render time and no font at view time. Render with `rsvg-convert -w 1200 -h 630 -b '#0d0b0a'`, which is the renderer this script already prefers for crisp strokes.

- [ ] **Step 4: Measure the rendered PNG and prove AA**

Do not assert the token values; measure the output. For each card, compute the WCAG ratio of headline, eyebrow, and support text against the pixels actually behind them, and the ratio of the ember stroke against the ground. Requirements: 4.5:1 for the 40px text, 3:1 for the 64px headline and for the mark as a non-text graphic. Record the numbers. Then repeat the measurement on the 630x630 center crop and the 504x630 4:5 crop, because a crop can change what is behind a glyph.

- [ ] **Step 5: Add the file shell beside the note shell**

`scripts/build-social-shell.mjs` currently derives `note.html` from `200.html` through a fixed `Map` and throws when a source string is missing, which is the right shape. Generalize it to emit both `note.html` and `file.html` from the same table, keeping the throw. Remove the duplicate tag emission identified in L5 by making the shell the only source for the reader cards, so the Svelte `<svelte:head>` no longer repeats `og:title` and `og:image`.

- [ ] **Step 6: Give the cards a cache policy and commit**

Add `--cache-control` to the card objects in `scripts/deploy-frontend.sh` so a replaced card is not stale forever (M5). Keep the stable filenames, because a previously unfurled preview still points at the old URL and a hashed name would strand it.

```bash
python3 scripts/build-brand.py --apply
node --test scripts/test-brand.test.mjs
pnpm build
git add scripts/build-brand.py scripts/build-social-shell.mjs scripts/deploy-frontend.sh static/og.png static/og-note.png static/og-file.png scripts/test-brand.test.mjs
git commit -m "🎨 feat(social): generate the card set from the brand source" -m "- replace a mid-rotation capture with the real merkaba" -m "- keep every element inside the square platforms crop to" -m "- add the missing file card and prove AA from rendered pixels"
```

---

### Task 5: Close the Two Accessibility Gaps and Ship the Declared Font

**Files:**
- Modify: `src/routes/field-notes/+page.svelte`
- Modify: `src/app.css:52` and the `@layer` block carrying focus styles
- Add: `static/fonts/` (subset Inter, or remove the declaration)

**Interfaces:**
- Every horizontally scrollable region is focusable and named.
- Every focusable element receives the designed focus ring, not a browser default.
- The declared font is either shipped first-party or not declared.

- [ ] **Step 1: Write the failing checks**

Assert every element whose `scrollWidth` exceeds its `clientWidth` and whose `overflow-x` is not `visible` has `tabindex="0"`, a `role`, and an accessible name. Assert every focusable element's settled `box-shadow` matches the designed ring. Per `.notes/GOTCHAS.md`, **wait past the 140ms `--dur-fast` transition before reading the computed style**, or the ring reads as fully transparent and looks exactly like a broken ring.

- [ ] **Step 2: Run and confirm failure**

```bash
pnpm exec playwright test --project=e2e --grep "scrollable|focus"
```

- [ ] **Step 3: Make the scroll region reachable and the ring universal**

Give the `<pre>` a `tabindex="0"`, `role="region"`, and an `aria-label` naming what it holds. Widen the focus-ring rule so it covers a bare `<a>` as well as `.btn` and `.link-quiet`. Do not put the rule in `src/app.css` behind `:global()`: that file is a plain stylesheet, not a component `<style>` block, so `:global()` is emitted verbatim and the browser drops the rule (`.notes/GOTCHAS.md`).

- [ ] **Step 4: Resolve the font declaration**

Either ship a self-hosted, subset Inter with an `@font-face` (`font-src 'self'` already permits it and forbids a CDN), or drop `Inter` from `--font-sans` so the stack states what actually renders. Shipping it is preferable, because `scripts/build-brand.py` already outlines Inter for the lockup and the card, and the site and its social card would otherwise set in two different typefaces. Do not add a Google Fonts link; the CSP forbids it and so does the privacy promise.

- [ ] **Step 5: Re-measure and commit**

Re-run the full contrast sweep after the font change. A typeface swap changes glyph coverage and therefore antialiasing, and the tightest ratio on the site is `.link-quiet` light at **4.64:1** against a 4.5 requirement. That margin is 0.14 and it is the first thing a font change will break.

```bash
pnpm test
pnpm check
pnpm exec playwright test --project=e2e
git add src/routes/field-notes src/app.css static/fonts
git commit -m "♿ fix(a11y): reach the scroll region and the focus ring" -m "- make the overflowing pre focusable and named" -m "- apply the designed ring where a browser default was showing" -m "- ship the font the stack already declares"
```

---

### Task 6: Correct the Stats Surface Against Its Measured Numbers

**Files:**
- Modify: `stats/site/stats.css:45-48`, `:56`, `:79`, `:84`
- Modify: `stats/site/dashboard.js`
- Modify: `stats/test-layout.mjs`

**Interfaces:**
- `.hero h1` and `.arrival-copy h1` set with a positive painted gap between lines at every width.
- `.metric-grid` reserves no height it cannot fill.
- A metrics failure renders a state, not an empty box.
- Word values and numeral values use different scales.

- [ ] **Step 1: Strengthen the test that passes on a broken page**

`stats/test-layout.mjs` currently asserts overflow, clipping, target size, and contrast, and passes on a headline whose glyphs touch. Add an assertion that measures the **painted ink gap** between consecutive line boxes of every multi-line heading and requires it to be greater than zero. Measure it the way this audit did: screenshot twice, the second time with ink forced transparent, and difference the two. A geometric line-box calculation will not catch it, because the em boxes are supposed to overlap at a display line-height; only painted pixels answer the question.

- [ ] **Step 2: Run and confirm failure**

```bash
node --test stats/test-layout.mjs
```

- [ ] **Step 3: Choose a line-height against real descender depth**

Replace `line-height: 0.86`. The value must be chosen from the measured descender depth of the actual strings (`only the infrastructure.` here) and verified by the ink-gap assertion, not picked because it looked right on one line. Record the chosen value and the resulting gap at 320, 375, 440, 768, and 1440 in both schemes. Before: **0px** at every one of those ten measurements.

- [ ] **Step 4: Stop reserving height that cannot be filled**

Remove `min-height: 20rem` from `.metric-grid`, which is inert when populated (content is 1224px at 320 and 885px at 1440) and produces the empty 288x320 box on failure. Give `dashboard.js` a real failure state in that space: a short line saying the aggregate read did not return and offering the retry, so the surface points somewhere instead of showing nothing. Reduce `.vault-artifact`'s reserved band so its three children are not separated by 296.9px of nothing at 768 and 304.6px at 1440.

- [ ] **Step 5: Separate the word scale from the numeral scale**

Keep the monumental `clamp(2rem, 7vw, 4rem)` for a numeral. Give a word value its own smaller scale, so `no samples` stops rendering at 64px against its own 16px label. While there, delete `overflow-wrap: anywhere` or comment why it stays: measured against the real value vocabulary it never fires at any width in either scheme, so it is currently dead defensive code and reads to the next person as evidence of a bug that does not exist.

- [ ] **Step 6: Re-measure and commit**

```bash
node --test stats/test-layout.mjs stats/test-metrics.mjs stats/test-auth.mjs
git add stats/site/stats.css stats/site/dashboard.js stats/test-layout.mjs
git commit -m "🐛 fix(stats): stop the headline lines from touching" -m "- choose a line-height against measured descender depth" -m "- reserve no height the grid cannot fill" -m "- give a word value its own scale"
```

`stats/test-auth.mjs` asserts the zero-retention boundary and must keep passing unchanged. Do not add an endpoint, an event, or a timeline to make the page look busier. The absence is the guarantee; the work is making the absence legible.

---

### Task 7: Prove the Live Boundary

**Files:**
- Verify: `template.yaml`, `scripts/deploy-frontend.sh`, deployed stack `blip`

- [ ] **Step 1: Run the complete release gate**

```bash
pnpm test
pnpm check
pnpm exec playwright test --project=e2e
pnpm build
node --test api/test/*.test.mjs
node --test stats/test-layout.mjs stats/test-metrics.mjs stats/test-auth.mjs
python3 scripts/build-brand.py
sam build
sam validate --lint
git diff --check
```

`sam build` leaves the previous artifact in place when it fails, and `sam deploy` will ship it. Check the real exit status and grep the artifact for a string only the new code contains before deploying anything (`.notes/GOTCHAS.md`).

- [ ] **Step 2: Inspect the change set without exposing parameters**

Follow the production update procedure in `docs/pro-payments.md` that preserves every current stack parameter with `UsePreviousValue: true`. Require the change set to show only the CloudFront distribution, function, and response-headers-policy updates. Any table replacement, bucket replacement, or IAM change is a stop.

- [ ] **Step 3: Deploy and verify the reader headers live**

```bash
./scripts/deploy-frontend.sh
```

Then, against live, confirm `X-Robots-Tag` with all five directives on `/n/<id>` and `/f/<locator>`, HTTP **404** on an unresolved path, HTTP **200** on every real route, and that all six existing security headers are byte-identical to their pre-deploy values on all four aliases.

- [ ] **Step 4: Prove the unfurl boundary did not move**

In a clean context, GET `/n/<id>` and `/f/<locator>` with no JavaScript and assert: zero API requests, zero occurrences of the requested id or locator anywhere in the response body or any meta tag, and the note still reveals exactly once afterward. Then reveal it and assert the second attempt returns `410`. An unfurl that consumed a note would be a critical regression.

- [ ] **Step 5: Prove the cards**

Fetch all three card URLs and assert 1200x630, an explicit `Cache-Control`, and byte-identity with the locally generated files. Re-measure AA from the fetched PNG, not the local one. Run each card through a real unfurl on at least two platforms and record what is legible at the size each one renders.

- [ ] **Step 6: Record and stop at the push gate**

Record live route, HTTP, header, card, IAM, and source-parity evidence in the current private release ledger. If `main` or another deploy-wired branch has not been explicitly authorized for push, leave the verified commits local and report the exact ahead count.

---

## Marlin decision request

Three verdicts are wanted, and one of them is a posture decision that is not the implementer's to make.

### Decision A: the `robots.txt` narrowing in Task 1

**What is being asked.** Remove `Disallow: /n/` and `Disallow: /f/` from `robots.txt` and rely on the `X-Robots-Tag` header instead.

**The evidence for it.** A `Disallow` prevents the fetch, and preventing the fetch is exactly what prevents any `noindex` from being read, so a disallowed URL linked from anywhere can still be indexed URL-only. Measured: the served reader shells contain **0** robots meta tags and no `X-Robots-Tag`. Meanwhile the compliant unfurlers Matt named all honor `robots.txt`, so the note card he asked to improve is probably not rendering on them today.

**The evidence against it.** It permits crawlers to fetch a reader shell. Verified consequences of that fetch: it returns a static shell with an empty body, it contains no locator, it cannot burn the note (burn is a POST behind the button), and the decryption key is in a fragment that no crawler ever sends. The residual disclosure is that a note id exists, which is only learnable from a link someone already published.

**Evidence Marlin should demand before `DEPLOY`:** live `curl` of `/n/` and `/f/` on all four aliases showing all five `X-Robots-Tag` directives; a no-JavaScript GET showing zero API calls and zero locator occurrences; and proof that the same note still reveals exactly once after being fetched by a crawler user agent. **`HOLD` if** the header is missing on any alias, or if any GET produces an API call. **`ROLLBACK` if** a reader GET consumes, mutates, or reveals anything.

**Recommendation:** ship the header in Task 1 unconditionally, and hold the `robots.txt` narrowing until Matt confirms he wants note links to unfurl on Slack and Twitter. It is his call, not a technical one.

### Decision B: the surface, SEO, and card work in Tasks 1 through 6

**Evidence Marlin should demand before `DEPLOY`:**

- The full audit table re-measured after the change, before and after side by side, at 320, 375, 440, 768, and 1440 in both schemes plus 200 percent text at 320. Numbers, not impressions.
- Contrast measured by the **ink and plate difference mask**, with the count of pairs measured and the count below AA. The before-value is 330 pairs and 0 failures; any regression to that is a stop. Reject any submission that reports a ratio derived from a luminance-extreme heuristic inside a bounding box: that method reported this site's light-mode `Reveal note` at 3.05:1 when it is 6.08:1.
- The tightest ratio on the site named explicitly. It is `.link-quiet` light at 320, currently **4.64:1** against 4.5. If Task 5 ships a font, this number must be re-measured and stated.
- The stats headline ink gap at all ten width-and-scheme combinations. Before: **0px** at every one.
- The three cards' rendered AA numbers, measured on the full card **and** on the 630x630 and 504x630 crops.
- The card figure's vertical-mirror overlap above 99%. Before: **14.0%**.
- Proof that all six security headers are byte-identical on all four aliases before and after.
- Proof that the card generator reads no runtime input: the `CARDS` literal table, the byte-identity test, and the head test asserting exactly three literal image URLs.

**`HOLD` if** any contrast pair drops below AA, any security header changes, the card generator gains an argument or a file read, or the ink-gap assertion is satisfied by a geometric calculation rather than measured pixels.

**`ROLLBACK` if** any reader GET performs an API call, if any meta tag on any route contains a locator or any payload-derived string, or if a card can be produced from anything other than the literal table.

### Decision C: C2, the sender-controlled MIME, which this plan does not fix

C2 is recorded, not repaired, because it is latent and because repairing it belongs with whoever ships the surface that makes it live. It matters here because Task 4 touches the card path and Task 2 touches the file route's head, and both are adjacent to it.

**What Marlin should require of the next lane that touches file rendering:** constrain the blob type to an allowlist rather than a `typeof` check, and treat anything outside it as `application/octet-stream`. Then, in the **same change**, correct the comment above `save()` in `src/routes/f/[locator]/+page.svelte`. It currently reads "Never a preview, never a server round trip, never anything that executes what was sent." That is true today and becomes **false** the moment a preview ships. A comment promising a security property the code no longer has is a defect in its own right, and it is the kind that survives every review because it reads like reassurance.

Whoever ships a preview owns all three: the allowlist, the comment, and a test that fails if a sender-supplied `text/html` ever reaches a rendering context at cinder.ink's origin, where the `cinder.sender-status.v1` tokens live.
