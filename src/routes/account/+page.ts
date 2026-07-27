// Everything on this page happens in the browser: the PKCE handshake, the code
// exchange, and the entitlement check. Prerendering the shell is right, but SSR
// is not — the OAuth callback arrives as ?code= on this exact URL, and a server
// render would mean the code passing through a server that has no business
// seeing it.
export const prerender = true;
export const ssr = false;
