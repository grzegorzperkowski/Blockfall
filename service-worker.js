"use strict";

// Network first, with a bounded wait and an offline app-shell fallback.
const CACHE_NAME = `blockfall-app-shell-${self.registration.scope}`;
const NETWORK_TIMEOUT_MS = 3000;
const APP_SHELL_URL = new URL("./", self.registration.scope).href;
const INDEX_URL = new URL("index.html", self.registration.scope).href;
const APP_SHELL = [
  APP_SHELL_URL,
  INDEX_URL,
  new URL("style.css", self.registration.scope).href,
  new URL("script.js", self.registration.scope).href
];

async function fetchWithTimeout(request) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), NETWORK_TIMEOUT_MS);
  try {
    return await fetch(request, { cache: "no-store", signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

async function cacheAppShell() {
  // Fetch the entire shell before updating the cache so a failed download
  // leaves the previously cached shell usable.
  const responses = await Promise.all(APP_SHELL.map(async url => {
    const response = await fetchWithTimeout(url);
    if (!response.ok) throw new Error(`Could not cache ${url}: ${response.status}`);
    return response;
  }));
  const cache = await caches.open(CACHE_NAME);
  await Promise.all(APP_SHELL.map((url, index) => cache.put(url, responses[index])));
}

async function cacheResponse(request, response) {
  if (!response.ok) return;
  const cache = await caches.open(CACHE_NAME);
  await cache.put(request, response.clone());
}

async function cachedFallback(request) {
  const cache = await caches.open(CACHE_NAME);
  const cachedResponse = await cache.match(request);
  if (cachedResponse) return cachedResponse;
  if (request.mode === "navigate") {
    return (await cache.match(APP_SHELL_URL)) || (await cache.match(INDEX_URL)) ||
      new Response("Open Blockfall once online before playing offline.", {
        status: 503,
        headers: { "Content-Type": "text/plain; charset=utf-8" }
      });
  }
  return new Response("Offline", {
    status: 503,
    headers: { "Content-Type": "text/plain; charset=utf-8" }
  });
}

self.addEventListener("install", event => {
  event.waitUntil((async () => {
    await cacheAppShell();
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", event => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", event => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin ||
      !url.href.startsWith(self.registration.scope)) return;

  event.respondWith((async () => {
    try {
      const response = await fetchWithTimeout(request);
      if (response.ok) {
        // Cache failures must not prevent a successful online response.
        await cacheResponse(request, response).catch(() => {});
        return response;
      }
      if (response.status < 500) return response;
    } catch {
      // Offline, timed-out and temporary server failures use the cached copy.
    }
    return cachedFallback(request);
  })());
});
