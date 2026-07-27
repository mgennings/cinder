// The landing page carries no secrets. Prerender it so the static deployment
// has a real index.html instead of relying on the client-only route fallback.
export const prerender = true;
export const ssr = true;
