# Theme & design system

This is the handoff for Cinder's look: how the dark theme is built, why it
reads the way it does, and the rules that keep it from drifting. If you're
touching a color, a shadow, or an animation, read this first — the system is
small on purpose, and most "improvements" that ignore it make it worse.

The whole thing lives in one file: [`src/app.css`](../src/app.css). Components
compose a handful of classes from it and stay dumb.

## The thesis

> Warm near-black surfaces, tasteful depth, earned glow, high trust. A haunted
> terminal with a heart of gold — southern-gothic aura, zero darknet cosplay.

Every decision below serves that sentence. When in doubt, ask "does this feel
like a lit room with a low fire in it, or like a hacker movie?" Ship the first
one.

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

`.btn:disabled` is styled once: no glow, no lift, ghosted text, `not-allowed`
cursor. It reads as "not yet," never "broken." Just add the `disabled` attribute.

## Accessibility contract

- Body/secondary/tertiary text meet WCAG AA on their intended surfaces in both
  themes. `--color-ghost` is tertiary/placeholder weight — don't use it for
  anything a user must read.
- `--color-ember-ink` exists because small ember text needs a darker ember on
  light backgrounds to stay AA. Use `text-ember-ink` for ember *text*, plain
  `ember` for fills/icons.
- Every interactive element gets `--focus-ring` on `:focus-visible`. Never
  remove an outline without replacing it.
- Honor `prefers-reduced-motion`. Always.

## Anti-patterns (the goblin's list of regrets)

- A second accent color. There is one ember. That's the joke and the discipline.
- Glow on resting borders / cards. Glow is earned by intent, not sprinkled.
- Cool grays. If it looks gray, warm it until it looks like ash, not steel.
- Flat fills with no catch-light or grain — the flatness is what cheapens it.
- Bouncy 400ms transitions on everything. Fast (140ms) or slow (>2s), never mush.
- Hardcoding a hex or a shadow in a component. If it's not a token, it drifts.
  Add a token, comment the *why*, and reference it.
