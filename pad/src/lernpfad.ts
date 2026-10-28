/**
 * Lernpfade für QPad-Projekte (Portierung von JPad: src/jpad/Lernpfad.ts).
 *
 * Ein Lernpfad ist eine HTML-Seite, die in der Projektdatei (Feld `lernpfadHtml`) mitreist und in der
 * Ansicht „Lernpfad“ angezeigt wird. Damit die Projektdatei eine einzige Datei bleibt, werden Bilder und
 * andere eingebundene Dateien als data-URIs direkt ins HTML geschrieben.
 *
 * Quellen:
 * - eine einzelne HTML-Datei oder ein ZIP (index.html mit Unterordnern wie img/), über das Menü
 * - ein Link: qpad…/?lernpfad=<URL zu .html/.zip/.sqlprojekt.json> (auch mit &projekt=… oder &vorlage=…)
 *
 * Ein Lernpfad kann im <head> angeben, welche Datenbank zu ihm gehört:
 *   <meta name="qpad-vorlage" content="pausenkiosk.sqLite">
 * Ein Dateiname meint eine Vorlage aus vorlagen/, sonst eine Adresse relativ zum Lernpfad.
 */

import { isZip, readZip } from "./importers.js";

const MIME: Record<string, string> = {
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
    svg: "image/svg+xml", avif: "image/avif", ico: "image/x-icon",
    css: "text/css", js: "text/javascript", mjs: "text/javascript", json: "application/json",
    mp3: "audio/mpeg", ogg: "audio/ogg", wav: "audio/wav", mp4: "video/mp4", webm: "video/webm",
    woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf", otf: "font/otf",
    pdf: "application/pdf", txt: "text/plain", sql: "text/plain"
};

function mimeOf(path: string): string {
    const ext = path.split(/[?#]/)[0].split(".").pop()!.toLowerCase();
    return MIME[ext] || "application/octet-stream";
}

/** „a/./b/../c“ → „a/c“ */
function normalize(path: string): string {
    const out: string[] = [];
    for (const part of path.split("/")) {
        if (part == "" || part == ".") continue;
        if (part == "..") out.pop(); else out.push(part);
    }
    return out.join("/");
}

function isExternal(ref: string): boolean {
    return /^([a-z][a-z0-9+.-]*:|\/\/|#|\$\{)/i.test(ref) || ref.trim() == "";
}

export function looksLikeHtml(text: string): boolean {
    return /<(html|body|div|p|h1|h2|section|main)\b/i.test(text);
}

function bytesToBase64(bytes: Uint8Array): string {
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
}

/**
 * Ersetzt eingebundene Dateien (src, href, poster, url(...)) durch das, was `resolve` liefert
 * (meist eine data-URI). Links auf andere HTML-Seiten werden nur über `link` umgeschrieben.
 */
async function inlineResources(html: string, resolve: (ref: string) => Promise<string | null>,
    link?: (ref: string) => string | null): Promise<string> {
    const pattern = /(\s(src|href|poster)\s*=\s*)(["'])([^"']*)\3|url\(\s*(["']?)([^"')]+)\5\s*\)/gi;
    const isPage = (attr: string | undefined, ref: string) => attr?.toLowerCase() == "href" && /\.html?([?#]|$)/i.test(ref);
    const refs = new Set<string>();
    for (const m of html.matchAll(pattern)) {
        const ref = m[4] ?? m[6];
        if (ref && !isExternal(ref) && !isPage(m[2], ref)) refs.add(ref);
    }
    const resolved = new Map<string, string>();
    for (const ref of refs) {
        const uri = await resolve(ref);
        if (uri) resolved.set(ref, uri);
    }
    return html.replace(pattern, (all, attr, name, q, ref1, q2, ref2) => {
        if (attr) {
            if (isExternal(ref1)) return all;
            const uri = isPage(name, ref1) ? link?.(ref1) : resolved.get(ref1);
            return uri ? `${attr}${q}${uri}${q}` : all;
        }
        const uri = resolved.get(ref2);
        return uri ? `url("${uri}")` : all;
    });
}

async function fromZip(bytes: Uint8Array, label: string): Promise<string> {
    let entries;
    try { entries = readZip(bytes); } catch (e) { throw new Error(`„${label}“ ist kein lesbares ZIP-Archiv.`); }
    const files = entries.filter(e => !e.name.endsWith("/") && !/(^|\/)(__MACOSX|\.)/.test(e.name));
    const htmlFiles = files.filter(e => /\.html?$/i.test(e.name)).sort((a, b) => a.name.split("/").length - b.name.split("/").length);
    const main = htmlFiles.find(e => /(^|\/)index\.html?$/i.test(e.name)) || htmlFiles[0];
    if (!main) throw new Error(`Im ZIP „${label}“ ist keine HTML-Seite.`);
    const base = main.name.includes("/") ? main.name.substring(0, main.name.lastIndexOf("/") + 1) : "";
    const html = new TextDecoder().decode(await main.read());
    return inlineResources(html, async (ref) => {
        const path = normalize(base + decodeURIComponent(ref.split(/[?#]/)[0]));
        const entry = files.find(e => e.name == path);
        return entry ? `data:${mimeOf(path)};base64,${bytesToBase64(await entry.read())}` : null;
    });
}

/** HTML von einer Adresse: Bilder usw. werden mitgeladen und eingebettet. */
async function fromUrlHtml(html: string, url: string): Promise<string> {
    return inlineResources(html, async (ref) => {
        const abs = new URL(ref, url).href;
        try {
            const r = await fetch(abs);
            if (!r.ok) return abs;
            const type = r.headers.get("content-type")?.split(";")[0] || mimeOf(abs);
            return `data:${type};base64,${bytesToBase64(new Uint8Array(await r.arrayBuffer()))}`;
        } catch (e) {
            return abs; // nicht ladbar (z. B. CORS): wenigstens die volle Adresse eintragen
        }
    }, (ref) => new URL(ref, url).href);
}

/** Notlösung, wenn der Server das Laden verweigert (CORS): Seite direkt von ihrer Adresse anzeigen (nur online). */
function framePage(url: string): string {
    const u = url.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`
        + `<style>html,body{margin:0;height:100%}iframe{border:0;width:100%;height:100%;display:block}</style></head>`
        + `<body><iframe src="${u}" allow="clipboard-write; fullscreen"></iframe></body></html>`;
}

export function titleOf(html: string): string | undefined {
    const m = html.match(/<title[^>]*>([^<]*)<\/title>/i) || html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
    if (!m) return undefined;
    const div = document.createElement("div");
    div.innerHTML = m[1];
    const t = div.textContent?.replace(/\s+/g, " ").trim();
    return t || undefined;
}

/** Vorlage, die der Lernpfad selbst nennt (<meta name="qpad-vorlage" content="…">) */
export function vorlageOf(html: string): string | undefined {
    const m = html.match(/<meta\s+[^>]*name\s*=\s*["']qpad-vorlage["'][^>]*>/i);
    return m?.[0].match(/content\s*=\s*["']([^"']+)["']/i)?.[1]?.trim() || undefined;
}

export function nameFromUrl(url: string): string {
    const parts = new URL(url, location.href).pathname.split("/").filter(s => s).map(s => decodeURIComponent(s));
    if (parts.length > 0 && /^index\.html?$/i.test(parts[parts.length - 1])) parts.pop();
    const last = parts.pop() || "Lernpfad";
    return last.replace(/\.(sqlprojekt\.json|html?|zip|json)$/i, "").replace(/[_-]+/g, " ").trim() || "Lernpfad";
}

/** Liest eine HTML- oder ZIP-Datei (Menü „Lernpfad einbetten“) und liefert eine eigenständige HTML-Seite. */
export async function readLernpfadFile(file: File): Promise<string> {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const html = isZip(bytes) ? await fromZip(bytes, file.name) : new TextDecoder().decode(bytes);
    if (!looksLikeHtml(html)) throw new Error(`„${file.name}“ sieht nicht nach einem Lernpfad (HTML-Seite) aus.`);
    return html;
}

export type LoadedLernpfad =
    | { kind: "html", html: string, name: string, note?: string }
    | { kind: "project", bytes: Uint8Array, name: string };

function corsError(url: string): Error {
    return new Error(`QPad kann „${url}“ nicht laden. Entweder ist die Adresse falsch, das Gerät offline, `
        + `oder der Server erlaubt anderen Seiten das Laden nicht (CORS). Am einfachsten liegt die Datei auf demselben `
        + `Server wie QPad oder auf GitHub Pages.`);
}

/**
 * Lädt einen Lernpfad über seine Adresse: HTML-Seite, ZIP oder Projektdatei (die dann selbst den
 * Lernpfad und die Datenbank enthält).
 */
export async function loadLernpfadUrl(url: string): Promise<LoadedLernpfad> {
    let r: Response;
    try {
        r = await fetch(url);
    } catch (e) {
        // HTML-Seite, die nicht geladen werden darf: direkt anzeigen (nur online)
        if (/\.(zip|json)([?#]|$)/i.test(url)) throw corsError(url);
        return {
            kind: "html", html: framePage(url), name: nameFromUrl(url),
            note: "Der Lernpfad wird direkt von seiner Adresse angezeigt und braucht deshalb eine Internetverbindung."
        };
    }
    if (!r.ok) throw new Error(`„${url}“ wurde nicht gefunden (Fehler ${r.status}).`);
    const bytes = new Uint8Array(await r.arrayBuffer());
    if (isZip(bytes)) {
        const html = await fromZip(bytes, nameFromUrl(url));
        return { kind: "html", html, name: titleOf(html) || nameFromUrl(url) };
    }
    const text = new TextDecoder().decode(bytes);
    if (/^\s*\{/.test(text)) return { kind: "project", bytes, name: nameFromUrl(url) };
    if (!looksLikeHtml(text)) throw new Error(`„${url}“ ist weder ein Lernpfad (HTML/ZIP) noch eine Projektdatei.`);
    const html = await fromUrlHtml(text, r.url || url);
    return { kind: "html", html, name: titleOf(html) || nameFromUrl(url) };
}

/**
 * Im abgeschotteten iframe ist localStorage gesperrt. Damit z. B. die Häkchen des Lernpfads erhalten
 * bleiben, bekommt die Seite einen Ersatz, der seine Daten per postMessage an QPad schickt.
 * Außerdem: Sprunglinks scrollen selbst, externe Links öffnen in einem neuen Tab (wie in JPad).
 */
export function withStorageShim(html: string, state: string): string {
    const shim = `<script>(function(){var ok=false;try{ok=!!window.localStorage;}catch(e){}if(ok)return;`
        + `var d=${(state || "{}").replace(/</g, "\\u003c")};function save(){parent.postMessage({type:"qpad-lernpfad-storage",state:d},"*");}`
        + `var s={getItem:function(k){k=String(k);return Object.prototype.hasOwnProperty.call(d,k)?d[k]:null;},`
        + `setItem:function(k,v){d[String(k)]=String(v);save();},removeItem:function(k){delete d[String(k)];save();},`
        + `clear:function(){d={};save();},key:function(i){return Object.keys(d)[i]||null;}};`
        + `Object.defineProperty(s,"length",{get:function(){return Object.keys(d).length;}});`
        + `try{Object.defineProperty(window,"localStorage",{value:s,configurable:true});}catch(e){}})();<\/script>`
        + `<script>document.addEventListener("click",function(e){var a=e.target&&e.target.closest&&e.target.closest("a[href]");if(!a)return;`
        + `var h=a.getAttribute("href")||"";if(h.charAt(0)=="#"){e.preventDefault();var id=decodeURIComponent(h.slice(1));`
        + `var t=id?(document.getElementById(id)||document.getElementsByName(id)[0]):document.body;if(t)t.scrollIntoView({behavior:"smooth",block:"start"});return;}`
        + `if(/^(https?:|mailto:)/i.test(h)){if(!a.target){e.preventDefault();window.open(a.href,"_blank","noopener");}return;}`
        + `if(!/^(data:|blob:|javascript:)/i.test(h))e.preventDefault();},true);<\/script>`;
    const m = html.match(/<head[^>]*>/i) || html.match(/<html[^>]*>/i);
    return m ? html.replace(m[0], m[0] + shim) : shim + html;
}
