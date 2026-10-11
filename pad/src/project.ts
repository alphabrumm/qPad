/**
 * Projekte: SQL-Skripte + Datenbank. Werden automatisch lokal im Browser (IndexedDB) gespeichert
 * und können als Projektdatei (*.sqlprojekt.json) heruntergeladen und wieder geöffnet werden.
 */

export type Script = { name: string, text: string };

export type Project = {
    id: string;
    name: string;
    scripts: Script[];
    activeScript: number;
    /** aktueller Stand der Datenbank (SQLite-Binärformat) */
    database: Uint8Array | null;
    /** Ausgangsdatenbank, auf die "Datenbank zurücksetzen" zurückgeht */
    template: Uint8Array | null;
    templateName: string;
    created: number;
    modified: number;
    /** Zeitpunkt des letzten Downloads (für den Hinweis "noch nicht heruntergeladen") */
    downloaded: number;
};

export const FILE_FORMAT = "sql-ide-pad-projekt";
export const FILE_VERSION = 1;

export function newProject(name = "Neues Projekt"): Project {
    const now = Date.now();
    return {
        id: "p" + now.toString(36) + Math.random().toString(36).substring(2, 7),
        name, scripts: [{ name: "Skript 1", text: "" }], activeScript: 0,
        database: null, template: null, templateName: "leere Datenbank",
        created: now, modified: now, downloaded: 0
    };
}

// ---------- Base64 für Binärdaten ----------
export function toBase64(data: Uint8Array): string {
    let s = "";
    const chunk = 0x8000;
    for (let i = 0; i < data.length; i += chunk) s += String.fromCharCode.apply(null, data.subarray(i, i + chunk) as any);
    return btoa(s);
}
export function fromBase64(b64: string): Uint8Array {
    const s = atob(b64);
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
}

// ---------- Projektdatei ----------
export function serializeProject(p: Project): string {
    const sameAsTemplate = p.database && p.template && equalBytes(p.database, p.template);
    return JSON.stringify({
        format: FILE_FORMAT, version: FILE_VERSION, app: "SQL-IDE für iPad",
        name: p.name, savedAt: new Date().toISOString(),
        scripts: p.scripts, activeScript: p.activeScript,
        templateName: p.templateName,
        database: p.database ? toBase64(p.database) : null,
        // Ausgangsdatenbank nur speichern, wenn sie sich vom aktuellen Stand unterscheidet
        template: p.template && !sameAsTemplate ? toBase64(p.template) : null,
        templateIsDatabase: !!sameAsTemplate
    }, null, 1);
}

export function parseProjectFile(text: string, fileName: string): Project {
    let json: any;
    try { json = JSON.parse(text); } catch (e) { throw new Error("Die Datei ist keine gültige Projektdatei."); }
    if (json?.format != FILE_FORMAT) throw new Error("Die Datei ist keine Projektdatei der SQL-IDE für iPad.");
    const p = newProject(json.name || fileName.replace(/\.sqlprojekt(\.json)?$|\.json$/i, ""));
    p.scripts = Array.isArray(json.scripts) && json.scripts.length > 0
        ? json.scripts.map((s: any, i: number) => ({ name: String(s.name ?? `Skript ${i + 1}`), text: String(s.text ?? "") }))
        : [{ name: "Skript 1", text: "" }];
    p.activeScript = Math.min(Math.max(0, json.activeScript | 0), p.scripts.length - 1);
    p.database = json.database ? fromBase64(json.database) : null;
    p.template = json.template ? fromBase64(json.template) : (json.templateIsDatabase && p.database ? p.database.slice() : null);
    p.templateName = json.templateName ?? "aus Projektdatei";
    p.downloaded = Date.now();
    return p;
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length != b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] != b[i]) return false;
    return true;
}

export function safeFileName(name: string): string {
    return (name || "projekt").replace(/[\\/:*?"<>|]+/g, "_").trim() || "projekt";
}

// ---------- Lokaler Speicher (IndexedDB) ----------
const DB_NAME = "sql-ide-pad";
const STORE = "projects";

function openIdb(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "id" });
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

async function tx<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const db = await openIdb();
    return new Promise<T>((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const req = fn(t.objectStore(STORE));
        t.oncomplete = () => { resolve(req.result); db.close(); };
        t.onerror = () => { reject(t.error); db.close(); };
        t.onabort = () => { reject(t.error); db.close(); };
    });
}

export const LocalStore = {
    available(): boolean { return typeof indexedDB != "undefined"; },
    save(p: Project): Promise<any> { return tx("readwrite", s => s.put(p)); },
    load(id: string): Promise<Project | undefined> { return tx("readonly", s => s.get(id) as IDBRequest<Project>); },
    remove(id: string): Promise<any> { return tx("readwrite", s => s.delete(id)); },
    async list(): Promise<Project[]> {
        const all = await tx("readonly", s => s.getAll() as IDBRequest<Project[]>);
        return all.sort((a, b) => b.modified - a.modified);
    }
};

const LAST_KEY = "sql-ide-pad.lastProject";
export function rememberLastProject(id: string) { try { localStorage.setItem(LAST_KEY, id); } catch (e) { } }
export function lastProjectId(): string | null { try { return localStorage.getItem(LAST_KEY); } catch (e) { return null; } }
