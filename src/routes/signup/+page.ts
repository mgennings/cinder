// Prerender the shell, never server-render. The session check reads
// sessionStorage and the PKCE handshake needs WebCrypto — both are browser-only,
// and a server render would produce a signed-out door for somebody who is not.
export const prerender = true;
export const ssr = false;
