/**
 * Web-Worker, in dem SQLite (sql.js, WebAssembly) läuft.
 * Protokoll: { id, action: "open" | "exec" | "export", buffer?, sql? } -> { id, results? , buffer?, error? }
 * Die SQL-Hilfsfunktionen (isDate, month, concat, ...) stammen unverändert aus der SQL-IDE.
 */
import { createDb } from "./sqlFunctions.js";

declare function importScripts(...urls: string[]): void;
declare function initSqlJs(config: any): Promise<any>;

importScripts("sql-wasm.js");

const sqlPromise = initSqlJs({ locateFile: (name: string) => name });
let db: any = null;

self.onmessage = async (event: MessageEvent) => {
    const data = event.data;
    try {
        const SQL = await sqlPromise;
        if (db == null) db = createDb(SQL, undefined);
        switch (data.action) {
            case "open":
                try { db.close(); } catch (e) { }
                db = createDb(SQL, data.buffer ? new Uint8Array(data.buffer) : undefined);
                (self as any).postMessage({ id: data.id, results: [] });
                break;
            case "exec":
                (self as any).postMessage({ id: data.id, results: db.exec(data.sql) });
                break;
            case "export": {
                const buffer: Uint8Array = db.export();
                // export() schaltet foreign keys aus -> wieder einschalten
                try { db.exec("PRAGMA foreign_keys = ON;"); } catch (e) { }
                (self as any).postMessage({ id: data.id, buffer }, [buffer.buffer]);
                break;
            }
            default:
                throw new Error("Unbekannte Aktion: " + data.action);
        }
    } catch (err: any) {
        (self as any).postMessage({ id: data.id, error: err?.message ?? String(err) });
    }
};
