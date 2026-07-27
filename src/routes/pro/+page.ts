// The pay point. Prerender the shell, but never server-render: the entitlement
// check and the checkout call both carry a bearer token, and a server render
// would mean a token passing through a server with no business holding one.
export const prerender = true;
export const ssr = false;
