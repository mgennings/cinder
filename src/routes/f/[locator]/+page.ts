// The locator is only known at runtime (it's in the URL), so never prerender
// this route, and keep it client-only — the fragment key and all decryption
// live in the browser and must never be part of a build artifact.
export const prerender = false;
export const ssr = false;
