# blip

A zero-knowledge, self-destructing note app. Write a note, blip encrypts it in your browser, and hands you one link. The first person to open that link reads the note once — then it's gone, permanently. The server that stores the note can never read it.

## How it works

The decryption key is generated in your browser and travels only in the URL fragment (`#...`), which browsers never send to a server. AWS stores ciphertext it cannot decrypt. The note self-destructs on first read via a single atomic DynamoDB operation — exactly one reader wins, ever.

## Run it locally

```bash
pnpm install
pnpm dev
```

## Design

- Spec: `docs/superpowers/specs/2026-07-01-blip-design.md`
- Plan: `docs/superpowers/plans/2026-07-01-blip.md`

## Stack

SvelteKit static SPA (Svelte 5) · Tailwind 4 · AES-256-GCM via Web Crypto · AWS SAM (API Gateway + Lambda + DynamoDB) · S3 + CloudFront.
