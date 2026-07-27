/// <reference types="@sveltejs/kit" />
/// <reference no-default-lib="true" />
/// <reference lib="esnext" />
/// <reference lib="webworker" />

// A minimal service worker: precache the built app shell so Cinder is
// installable and opens instantly offline. Note and file content is never
// cached — it's one-time and always fetched live — so this only ever holds
// static assets.

import { build, files, version } from '$service-worker';

const sw = self as unknown as ServiceWorkerGlobalScope;
const CACHE = `cinder-cache-${version}`;
// adapter-static's SPA fallback shell isn't in build/files, so precache it by hand.
const SHELL = '/200.html';
const ASSETS = [...build, ...files, SHELL];

sw.addEventListener('install', (event) => {
	event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ASSETS)).then(() => sw.skipWaiting()));
});

sw.addEventListener('activate', (event) => {
	event.waitUntil(
		caches
			.keys()
			.then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
			.then(() => sw.clients.claim())
	);
});

sw.addEventListener('fetch', (event) => {
	const { request } = event;
	if (request.method !== 'GET') return;

	const url = new URL(request.url);
	// Never touch the API. Note burns and file claims are one-shot and
	// destructive: a cached response would be a copy of something Cinder
	// promised it no longer has. Claims are POSTs and already excluded above,
	// but this is the rule stated where someone will actually read it.
	if (url.pathname.startsWith('/notes') || url.pathname.startsWith('/files')) return;

	// Cross-origin requests (the presigned upload to the private bucket) are
	// never ours to cache or serve.
	if (url.origin !== location.origin) return;

	// Cache-first for our own precached static assets; network for everything else.
	if (ASSETS.includes(url.pathname)) {
		event.respondWith(caches.match(request).then((cached) => cached ?? fetch(request)));
		return;
	}

	// App-shell fallback: if the network fails for a navigation, serve the shell
	// so an installed Cinder still opens offline (the SPA then routes client-side).
	if (request.mode === 'navigate') {
		event.respondWith(fetch(request).catch(() => caches.match(SHELL) as Promise<Response>));
	}
});
