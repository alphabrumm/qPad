// Service Worker: hält die App offline verfügbar. Version wird beim Build eingesetzt.
const CACHE = "sql-ide-pad-0b0a261e99";
const SHELL = ["./","index.html","style.css","app.js","worker.js","sql-wasm.js","sql-wasm.wasm","manifest.webmanifest","icon.svg","icon-180.png","icon-512.png"];

self.addEventListener("install", e => {
    e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
    e.waitUntil(caches.keys()
        .then(keys => Promise.all(keys.filter(k => k.startsWith("sql-ide-pad-") && k != CACHE).map(k => caches.delete(k))))
        .then(() => self.clients.claim()));
});

self.addEventListener("fetch", e => {
    const req = e.request;
    if (req.method != "GET" || new URL(req.url).origin != location.origin) return;
    const url = new URL(req.url);
    const isList = url.pathname.endsWith("vorlagen.json");
    if (req.mode == "navigate" || isList) {
        // Netz zuerst, damit Aktualisierungen ankommen
        e.respondWith(fetch(req).then(r => {
            const copy = r.clone();
            caches.open(CACHE).then(c => c.put(isList ? req : "index.html", copy));
            return r;
        }).catch(() => caches.match(isList ? req : "index.html")));
        return;
    }
    // sonst Cache zuerst; Vorlagen werden beim ersten Abruf zwischengespeichert
    e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(r => {
        if (r.ok && url.pathname.includes("/vorlagen/")) {
            const copy = r.clone();
            caches.open(CACHE).then(c => c.put(req, copy));
        }
        return r;
    })));
});
