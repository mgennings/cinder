# Theme & design system

This is the handoff for Cinder's look: how the dark theme is built, why it
reads the way it does, and the rules that keep it from drifting. If you're
touching a color, a shadow, or an animation, read this first — the system is
small on purpose, and most "improvements" that ignore it make it worse.

The whole thing lives in one file: [`src/app.css`](../src/app.css). Components
compose a handful of classes from it and stay dumb.

**The classes are not the API any more.** `src/lib/ui/` wraps every one of them
in a component, arranged by level:

| Level | Where | What lives there |
| --- | --- | --- |
| Atoms | `src/lib/ui/atoms/` | `Button`, `Card`, `TextInput`, `Select`, `Checkbox`, `FileInput`, `TextArea`, `ProgressBar`, `PulseDot`, `QuietLink`, `RuleHead`, `Alert`, `LiveRegion`, `Wordmark`, `Merkaba` |
| Molecules | `src/lib/ui/molecules/` | `Record`, `RecordRow`, `SegmentedChoice`, `PhaseProgress`, `TruthCard`, `CopyLink`, `ProviderButtons` |
| Organisms | `src/lib/ui/organisms/` | `SendComposer`, `RevealGate`, `TransferRecord`, `LinkReadyPanel`, `OutcomePanel`, `StoredDataTable`, `PaymentDisclosure`, `TruthList`, `SignInPanel`, `AuthDoor`, `SiteFooter` |
| Templates | `src/lib/ui/templates/` | `VaultPage` (the signature surface), `BenchPage` (the reading surfaces) |

Reach for the component, not the class. Writing `class="btn btn-ember"` by hand
is how the 44px floor, the focus halo, and the disabled state drift apart on the
one control a person has to press. A route that needs a surface `app.css` does
not have yet adds the rule here first, then the atom that owns it.

Organisms hold product copy; atoms and molecules never do. That line is what
keeps a shipped sentence findable — every user-facing string in the sending and
receiving journeys lives in exactly one organism, and `src/lib/claims.test.ts`
pins the reveal warning to `organisms/RevealGate.svelte` by name.

## The thesis

> Warm near-black surfaces, tasteful depth, earned glow, high trust. A haunted
> terminal with a heart of gold — southern-gothic aura, zero darknet cosplay.

Every decision below serves that sentence. When in doubt, ask "does this feel
like a lit room with a low fire in it, or like a hacker movie?" Ship the first
one.

### The instrument amendment

Matt asked for the room to be read as an instrument bench, and it now is. That
is a real change to this document and it is written down rather than absorbed.

The thesis did not move. What moved is the answer to "what is the room made
of," and the answer is a surveyor's grid — a ruled substrate under the glow,
behind the record panel, along the progress track, and across the top of every
document page. Cinder is a set of technical readouts of things a server
actually did, and it now looks like one.

One system owns the page, and it is the terrain. A tick-mark bezel around the
merkaba was built and then deleted: stacking a second piece of instrument
geometry on the first is how a signature turns into a costume, and the crest
was already doing its job.

The line between an instrument and a costume is not the amount of geometry, it
is whether the geometry claims anything. So the amendment carries three limits,
and they are the whole difference:

- **The grid never carries meaning.** It is not a status, not a control border,
  not text, not a scale with numbers attached. It is texture — the same
  category as the film grain, one step more deliberate.
- **Nothing is invented.** No fabricated telemetry, no sequence numbers, no
  `VERIFIED` the system cannot prove, no hostname, no fake terminal. Every word
  in a readout is still a fact the code entails. On an encryption product,
  fabricated technicality is not art direction, it is a lie about the one thing
  being sold.
- **Ember is still the only accent.** See below.

What stayed banned is what was always the actual objection: skulls, glitch
text, chromatic aberration, matrix rain, glow on resting borders, and anything
that makes a tool people trust with a secret look like a toy.

## Tokens (the design language)

Tokens are declared in the Tailwind 4 `@theme` block, so each `--color-*`
becomes a utility (`--color-ink` → `bg-ink`, `text-ink`, …). Flipping the same
variables under `prefers-color-scheme: light` re-themes the entire app with no
markup changes. **Keep token names stable** — markup depends on them.

### Neutrals are warm, never gray

Every near-black leans red > green > blue by a hair. Pure `#0a0a0f` reads cold
and digital; the warm charcoals read like a room, not a void. This single
choice is ~80% of the "clear-web, not darknet" feel.

| Token | Role |
| --- | --- |
| `--color-ink` | Vault floor — deepest surface, and the recessed field fill |
| `--color-ink-soft` | Raised card sitting above the floor |
| `--color-ink-raised` | Highest surface: hover wells, popovers |
| `--color-line` / `--color-line-strong` | Hairline borders / borders meant to be seen |
| `--color-body` / `--color-mist` / `--color-ghost` | Primary / secondary / tertiary text |
| `--color-ember` (+ `-soft` `-ink` `-deep`) | The one accent. Constant across themes. |

### Ember is the only accent

One warm accent that nods at the burn. It does not get a friend. Success,
info, and "live" states are all ember — restraint is the brand. `--color-ember`
holds across light/dark; only the neutrals flip.

### The grid is geometry, not an accent

`--signal-grid`, `--signal-grid-strong`, and `--grid-cell` are the instrument
substrate. A cool ash-blue at 5–9% alpha: the cold room the fire sits in.

They are the one set of visual variables **declared outside the `@theme`
block**, and that placement is the enforcement rather than a formatting
preference. A token inside `@theme` becomes a Tailwind utility, and the moment
`text-grid` exists somebody paints words with it. Outside it, the grid can only
be reached from a rule in `app.css` — which means it can only ever be geometry.

It does not violate "ember is the only accent," because it is not an accent. It
never marks a status, never outlines a control, and never touches type. If you
find yourself wanting it to say something, that is the signal that the thing
wanting to be said needs ember and a word.

In light mode the grid inverts to blueprint ink on paper rather than being
faded out. A washed-out dark mode is the tell that only one appearance was
designed. The two appearances do NOT share an alpha — the light values are
roughly a third of the dark ones, because the same ruling on paper darkened the
ground under the wordmark until the 30px ember period measured 2.81:1 against a
3:1 floor. Every number here was measured on rendered pixels at 375px, and any
change to them has to be measured again.

`--signal-terrain` is a second, stronger pair for surfaces that are **masked**
— the hero terrain and the bench. A radial or linear mask multiplies alpha down
to nothing at its edges, so a masked layer needs a stronger source to arrive at
the same strength as an unmasked panel. At panel alpha the hero grid rendered a
nine-level delta on the floor color and was invisible in a screenshot.

## The depth recipe

A card is **lifted off the floor**, not just filled a shade lighter. `--shadow-card`
layers four things, and you want all four:

1. **Inset top catch-light** (`--edge-light`) — the edge nearest the light.
   This is the detail that sells "physical." Skip it and the card goes flat.
2. **Tight contact shadow** — the card touching the surface.
3. **Mid ambient shadow** — the body of the lift.
4. **Wide, very soft floor shadow** — the room around it.

Fields invert the logic: they're **recessed** into the card via `--shadow-inset`
plus the darker `--color-ink` fill. Raised card, cut-in field — that contrast is
the depth. Surfaces should always read as a stack (floor → card → inset), never
as three arbitrary grays.

## The floor color lives on `html`, not `body`

This one line is load-bearing and it does not look it.

`html`'s background propagates to the canvas and paints beneath everything.
`body`'s background does not — it paints as an ordinary block background,
**above** any descendant at `z-index: -1`. Both the vault glow and the signal
terrain are `z-index: -1` pseudos.

With the color on `body`, they were only visible when something else happened
to promote them onto their own compositing layer, and for the glow that
something was its own drift animation. Which meant the glow **disappeared
entirely under `prefers-reduced-motion`**: the rule that stops the drift also
removes the transform that was promoting it, so the preference that is supposed
to hold every form and drop every movement was dropping the form too. Nobody
saw it, because nothing errored and the computed styles were all correct.

`tests/e2e/terrain.spec.ts` guards it by removing each layer and asserting the
picture changes. If a layer can be deleted without changing a single pixel, it
was never on screen.

## The glow recipe

Glow is **earned**, never ambient-everywhere. It lives in exactly two places:

- **Behind the hero** — `.vault-glow` paints two radial ember washes and drifts
  them almost imperceptibly (idle motion, below).
- **On the primary action** — `.btn-ember` glows at rest (`--glow-ember-rest`),
  brightens on intent (`--glow-ember-lift`), and sinks on press. The button is
  the one control allowed to glow unprompted, because it *is* the prompt.

Everything else earns glow only on `:focus-visible`, via `--focus-ring` — a
two-stop halo (dark spacer ring + soft ember) so it's visible on any surface.
Glow-on-every-border is the darknet-cosplay tell. Don't.

## The motion recipe

Two speeds, nothing in between:

- **Steered motion** is the one addition, and it has no clock: the signal
  terrain leans a few pixels toward the pointer via `--sx`/`--sy`, written by
  the attachment in [`src/lib/ui/terrain.ts`](../src/lib/ui/terrain.ts). No
  loop, no canvas, nothing running while the pointer is still. It refuses to
  attach under reduced motion or on a coarse pointer, and both properties
  default to `0`, so the frame it composes is the frame a page with no script
  renders. The grid itself never animates on its own — the glow already drifts,
  and two ambient loops in one hero is the mush the rule below forbids.
- **Idle motion** is slow enough to doubt you saw it: vault glow drift ~22s,
  merkaba breath ~6s, loading shimmer ~1.8s. It makes the room feel alive.
- **Response motion** is fast and crisp (`--dur-fast` 140ms, `--ease-crisp`):
  hover lift, press sink, focus ring. It answers the user immediately.

The "demo speed" middle (300–600ms bouncy everything) is banned. The burn
(`.burning`, 900ms) is the one deliberate exception — a moment we *want* felt.

`prefers-reduced-motion: reduce` holds every form and drops every movement:
animations off, transforms neutralized, transitions collapsed to ~0. Color,
depth, and focus all still work. Test with it on.

## Texture

`body::before` lays a whisper of static SVG turbulence (~2.8% opacity) over the
whole vault so flat fills stop looking flat — the "haunted terminal" grain. The
entire point is that you feel it and never see it. Turn it up and it's instantly
cringe; if you're tempted, turn it *down*.

## Component classes

Compose these; don't re-hand-roll their guts in markup.

| Class | Use |
| --- | --- |
| `.card` | Any raised surface (composer, reader, security rows) |
| `.field` | `input` / `select` / `textarea` / revealed-note `pre` — recessed, ember focus |
| `.btn` + `.btn-ember` | The primary ember action (glow contract baked in) |
| `.btn` + `.btn-ghost` | Quiet secondary / navigation actions |
| `.link-quiet` | Text links — mist at rest, ember underline on intent |
| `.shimmer` / `.pulse-dot` | Loading sweep / "live now" pulse |
| `.util` | Instrument caption — mono, small, tracked. Marks a machine fact, never prose |
| `.rule-head` | A section heading with a hairline running out to the measure's edge |
| `.record-data` | A record value that IS a measurement (byte count, filename) — mono |
| `.bench` | A document page: the grid holds the top 20rem and is gone before the prose |

`.record` is the instrument face. It carries the grid, a gutter rule down its
left edge, and `.record-mark` lamps. A `.record-value` that states a *claim*
stays in body type; only a measurement gets `.record-data`. Mono borrows
authority, and a claim has to earn its authority in words.

`.btn:disabled` is styled once: no glow, no lift, ghosted text, `not-allowed`
cursor. It reads as "not yet," never "broken." Just add the `disabled` attribute.

## Accessibility contract

- Body/secondary/tertiary text meet WCAG AA on their intended surfaces in both
  themes. `--color-ghost` is tertiary/placeholder weight — don't use it for
  anything a user must read. `.util` and `.record-label` are `--color-mist` for
  exactly that reason: a caption on a technical panel is read, and on the ruled
  record in light mode ghost measured 4.34:1 against a 4.5 floor.
- A status mark gets space around it, not a glow. A soft ember ring was tried
  and measured: it became the color *adjacent* to the lamp, which is what a 3:1
  non-text ratio is measured against, and it took the light-mode mark from
  3.33:1 to 2.48:1.
- Any change to the grid, the terrain, or a text color gets re-measured on
  rendered pixels in both schemes at 375px. A background *image* is invisible to
  `getComputedStyle().backgroundColor`, so a contrast number derived from CSS is
  a number about the stylesheet, not about the screen. The method that works:
  photograph the page twice, once normally and once with every glyph
  transparent, and read the background off the second plate. Separating ink from
  ground by color distance or by pixel frequency both fail on the same thing —
  a paragraph's antialiasing ramp sits between the two, and any threshold that
  excludes it also excludes a 1px grid line.
- `--color-ember-ink` exists because small ember text needs a darker ember on
  light backgrounds to stay AA. Use `text-ember-ink` for ember *text*, plain
  `ember` for fills/icons.
- Every interactive element gets `--focus-ring` on `:focus-visible`. Never
  remove an outline without replacing it.
- Honor `prefers-reduced-motion`. Always.

## Anti-patterns (the goblin's list of regrets)

- A second accent color. There is one ember. That's the joke and the discipline.
  The grid is not a counterexample — it is geometry, it says nothing, and the
  moment it says something it has become the thing this line forbids.
- Fabricated technicality. A readout row, a status word, a counter, or a label
  that the code cannot back is worse here than anywhere else, because the
  product IS the claim. If it cannot be proven, it does not get printed.
- A grid behind body copy. `.bench` stops before the first paragraph on purpose.
- Glow on resting borders / cards. Glow is earned by intent, not sprinkled.
- Cool grays. If it looks gray, warm it until it looks like ash, not steel.
- Flat fills with no catch-light or grain — the flatness is what cheapens it.
- Bouncy 400ms transitions on everything. Fast (140ms) or slow (>2s), never mush.
- Hardcoding a hex or a shadow in a component. If it's not a token, it drifts.
  Add a token, comment the *why*, and reference it.
