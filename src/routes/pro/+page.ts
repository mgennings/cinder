// The pay point. Prerender its public shell so crawlers and no-JavaScript
// visitors receive truthful metadata. Entitlement and checkout still begin
// only after onMount, so bearer tokens remain browser-only.
export const prerender = true;
export const ssr = true;
