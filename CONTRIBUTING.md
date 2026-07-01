# Contributing to Cinder

Thanks for wanting to help. Cinder is a small, focused privacy tool, and that focus is deliberate — contributions that keep it small and sharp are the most welcome kind.

## Principles

Before you write code, know what Cinder optimizes for:

- **Less code is a feature.** Every line shipped to the browser is a line a security-conscious user has to trust. Prefer removing code to adding it. A clever dependency that saves ten lines but adds a trust surface is usually a bad trade.
- **The server must never be able to read a note.** Any change that would send the key, the plaintext, or anything derived from them to the server is a non-starter. When in doubt, ask whether the change preserves zero-knowledge.
- **Honesty over marketing.** The [security page](docs/security.md) states real limits plainly. Keep it that way. Do not soften a limitation to make the tool sound stronger than it is.

## Getting set up

Follow [Local development](docs/local-development.md) to run the full stack on your machine. In short:

```bash
pnpm install
./scripts/dynamodb-local.sh          # terminal 1
node scripts/dev-api.mjs             # terminal 2
VITE_API_BASE=http://localhost:4000 pnpm dev   # terminal 3
```

## Before you open a pull request

Run the full checks:

```bash
pnpm check                           # types
pnpm vitest run                      # unit tests
cd api && node --test test/*.mjs     # api tests (needs DynamoDB Local)
pnpm exec playwright test            # e2e (needs DynamoDB Local + dev API)
```

All of them should pass. If you changed crypto, storage, or the burn logic, add or update the test that proves the behavior — the tests that matter most are the ones that verify the security claims (tamper-detection, single-winner burns, expired notes never served).

## Style

- Match the surrounding code. Comments explain *why*, not *what*.
- Keep files focused. If a file is doing two jobs, that is a signal to split it.
- Commit messages use a short type prefix and describe the change plainly.

## What makes a good contribution

- A bug fix with a test that fails before and passes after.
- A documentation improvement — clearer explanations are as valuable as code.
- A security hardening that does not add trust surface.
- A UI or accessibility improvement that keeps the app small and fast.

## What to discuss first

Open an issue before starting on anything that:

- Adds a dependency, especially a crypto or network one.
- Changes the wire format or the burn semantics.
- Expands the API surface.

These touch the core guarantees, so it is worth agreeing on the approach before you build.
