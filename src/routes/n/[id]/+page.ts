// The note id is only known at runtime (it's in the URL), so never prerender
// this route, and keep it client-only — the fragment key and all decryption
// live in the browser.
export const prerender = false;
export const ssr = false;
