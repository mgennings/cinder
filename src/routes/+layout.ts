// blip is a client-only SPA — all crypto happens in the browser and the
// note routes have nothing to render server-side. Landing/security pages
// opt back into prerender individually.
export const ssr = false;
export const prerender = false;
