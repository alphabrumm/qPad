/**
 * Öffnen von Dateien: Projektdateien, SQLite-Datenbanken (auch zlib-komprimiert), SQL-/MySQL-Dumps (auch gezippt).
 * Der Dump-Import ist eine Portierung von src/tools/MySqlImporter.ts (SQL-IDE).
 */
import { Lexer } from "../../src/client/compiler/lexer/Lexer.js";
import { TokenType } from "../../src/client/compiler/lexer/Token.js";
import type { AlterTableNode, CreateTableNode, InsertNode } from "../../src/client/compiler/parser/AST.js";
import { Parser } from "../../src/client/compiler/parser/Parser.js";
import { StatementCleaner } from "../../src/client/compiler/parser/StatementCleaner.js";
import type { PadDatabase } from "./db.js";
import { PadModule } from "./module.js";
import { parseProjectFile, Project } from "./project.js";

export type Opened =
    | { kind: "project", project: Project }
    | { kind: "database", data: Uint8Array, name: string, errors: string[] };

const isSqlite = (b: Uint8Array) => b.length > 16 && String.fromCharCode(...b.subarray(0, 15)) == "SQLite format 3";
const isZlib = (b: Uint8Array) => b.length > 2 && b[0] == 0x78 && [0x01, 0x5e, 0x9c, 0xda].includes(b[1]);
export const isZip = (b: Uint8Array) => b.length > 4 && b[0] == 0x50 && b[1] == 0x4b && b[2] == 0x03 && b[3] == 0x04;

async function inflate(data: Uint8Array, format: "deflate" | "deflate-raw"): Promise<Uint8Array> {
    if (typeof (globalThis as any).DecompressionStream == "undefined") {
        throw new Error("Dieser Browser kann komprimierte Dateien nicht entpacken (iPadOS 16.4 oder neuer nötig).");
    }
    const ds = new (globalThis as any).DecompressionStream(format);
    const stream = new Blob([data as BlobPart]).stream().pipeThrough(ds);
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

export type ZipEntry = { name: string, read: () => Promise<Uint8Array> };

/** Liest das Inhaltsverzeichnis einer ZIP-Datei; die Einträge werden erst bei read() entpackt */
export function readZip(zip: Uint8Array): ZipEntry[] {
    const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    // Zentralverzeichnis suchen (End of central directory)
    let eocd = -1;
    for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65557); i--) {
        if (dv.getUint32(i, true) == 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error("Die ZIP-Datei ist beschädigt.");
    const count = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true);
    const dec = new TextDecoder();
    const entries: ZipEntry[] = [];
    for (let i = 0; i < count; i++) {
        if (dv.getUint32(p, true) != 0x02014b50) break;
        const method = dv.getUint16(p + 10, true);
        const compSize = dv.getUint32(p + 20, true);
        const nameLen = dv.getUint16(p + 28, true), extraLen = dv.getUint16(p + 30, true), commentLen = dv.getUint16(p + 32, true);
        const lp = dv.getUint32(p + 42, true);
        const name = dec.decode(zip.subarray(p + 46, p + 46 + nameLen));
        entries.push({
            name, read: async () => {
                const start = lp + 30 + dv.getUint16(lp + 26, true) + dv.getUint16(lp + 28, true);
                const raw = zip.subarray(start, start + compSize);
                return method == 0 ? raw.slice() : await inflate(raw, "deflate-raw");
            }
        });
        p += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
}

/** Liest den ersten passenden Eintrag (.sql/.sqlite/.db) aus einer ZIP-Datei */
async function unzipFirst(zip: Uint8Array): Promise<{ name: string, data: Uint8Array }> {
    const entries = readZip(zip);
    const entry = entries.find(e => /\.(sql|sqlite|db|sqlite3)$/i.test(e.name) && !e.name.startsWith("__MACOSX"))
        ?? entries.find(e => !e.name.endsWith("/"));
    if (!entry) throw new Error("Die ZIP-Datei enthält keine Datenbank.");
    return { name: entry.name, data: await entry.read() };
}

export async function openFile(bytes: Uint8Array, fileName: string, db: PadDatabase,
    progress: (msg: string) => void): Promise<Opened> {

    let name = fileName;
    if (isZip(bytes)) {
        progress("Entpacke ZIP-Datei …");
        const e = await unzipFirst(bytes);
        bytes = e.data; name = e.name;
    }
    if (isZlib(bytes)) {
        progress("Entpacke Datenbank …");
        bytes = await inflate(bytes, "deflate");
    }
    if (isSqlite(bytes)) return { kind: "database", data: bytes, name, errors: [] };

    const text = new TextDecoder().decode(bytes);
    if (text.trimStart().startsWith("{")) return { kind: "project", project: parseProjectFile(text, fileName) };

    progress("Importiere SQL-Dump …");
    const { data, errors } = await importDump(text, db, progress);
    return { kind: "database", data, name, errors };
}

/** Führt einen (MySQL-)Dump in einer leeren Datenbank aus und liefert die fertige SQLite-Datenbank */
export async function importDump(text: string, db: PadDatabase, progress: (msg: string) => void): Promise<{ data: Uint8Array, errors: string[] }> {
    const lexed = new Lexer().lex(text);
    const m = new PadModule(text);
    m.tokenList = lexed.tokens;
    new Parser().parse(m as any);

    const statements = m.sqlStatements;
    const createTableNodes = statements.filter(st => st.ast?.type == TokenType.keywordCreate).map(st => <CreateTableNode>st.ast);
    const findCreate = (id: string) => createTableNodes.find(n => n.identifier?.toLocaleLowerCase() == id.toLocaleLowerCase());
    const alterNodes = statements.filter(st => st.ast?.type == TokenType.keywordAlter && (<AlterTableNode>st.ast).kind == "omittedKind").map(st => <AlterTableNode>st.ast);

    for (const tmn of alterNodes) {
        const ct = findCreate(tmn.tableIdentifier);
        if (ct == null) continue;
        const findCol = (id: string) => ct.columnList.find(c => c.identifier.toLocaleLowerCase() == id.toLocaleLowerCase());
        if (tmn.primaryKeys != null) {
            ct.combinedPrimaryKeyColumns = tmn.primaryKeys;
            ct.columnList.forEach(c => c.isPrimary = false);
        }
        if (tmn.autoIncrementColumn != null) {
            const c = findCol(tmn.autoIncrementColumn);
            if (c != null) c.isPrimary = true;
        }
        if (tmn.modifyColumnInfo != null) {
            for (const mci of tmn.modifyColumnInfo) {
                const idx = ct.columnList.indexOf(findCol(mci.identifier));
                if (idx >= 0) ct.columnList.splice(idx, 1, mci);
            }
        }
        if (tmn.foreignKeys != null) for (const fk of tmn.foreignKeys) ct.foreignKeyInfoList.push(fk);
        if (tmn.indices != null) {
            for (const index of tmn.indices) {
                statements.push(<any>{
                    acceptedBySQLite: true, from: null, to: null, hasErrors: false, resultTypes: [],
                    ast: { type: TokenType.keywordIndex, columnIdentifier: index.column, indexIdentifier: index.index_name,
                        tableIdentifier: tmn.tableIdentifier, unique: index.unique, position: null, endPosition: null, symbolTable: null },
                    // Indexnamen sind in MySQL nur je Tabelle eindeutig, in SQLite global -> Tabellenname voranstellen
                    sql: `create ${index.unique ? 'unique ' : ''}index if not exists "${tmn.tableIdentifier}_${index.index_name}" on "${tmn.tableIdentifier}"(${index.column});`
                });
            }
        }
    }

    // Quelltext jeder Anweisung bestimmen (für Anweisungen, die der StatementCleaner unverändert übernimmt)
    const lineStarts = [0];
    for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) == 10) lineStarts.push(i + 1);
    const off = (p: { line: number, column: number }) => (lineStarts[p.line - 1] ?? text.length) + p.column - 1;
    for (const st of statements) {
        if (st.sql == null && st.from != null && st.to != null) st.sql = text.substring(off(st.from), off(st.to));
    }

    const cleaner = new StatementCleaner();
    // ALTER-Anweisungen aus MySQL-Dumps (Primärschlüssel, Auto-Increment, Fremdschlüssel, Indizes)
    // wurden oben in die create-table-Anweisungen bzw. eigene Index-Anweisungen übernommen
    const merged = new Set<any>(alterNodes);
    const sql = statements.filter(st => st.ast != null && st.ast.type != TokenType.omittedeStatement && !merged.has(st.ast)
        // MySQL-spezifische ALTER-Varianten, die SQLite nicht versteht und der Parser nicht vollständig erkennt
        && !(st.ast.type == TokenType.keywordAlter && st.hasErrors))
        .map(st => cleaner.clean(st)).filter(s => s != null && s.trim() != "");

    await db.open(null);
    await db.exec("PRAGMA foreign_keys = OFF;");
    const errors: string[] = [];
    const CHUNK = 200;
    for (let i = 0; i < sql.length; i += CHUNK) {
        progress(`Importiere SQL-Dump … ${Math.round(100 * i / sql.length)} %`);
        const chunk = sql.slice(i, i + CHUNK);
        try {
            // schneller Weg: ganzer Block in einer Transaktion
            await db.exec("begin;\n" + chunk.map(s => s.trim().replace(/;?$/, ";")).join("\n") + "\ncommit;");
        } catch (e) {
            try { await db.exec("rollback;"); } catch (e2) { }
            // langsamer Weg: einzeln, damit nur fehlerhafte Anweisungen fehlen
            for (const s of chunk) {
                try { await db.exec(s); }
                catch (err) { errors.push(`${err}\n   bei: ${s.substring(0, 200)}`); }
            }
        }
    }
    await db.exec("PRAGMA foreign_keys = ON;");
    return { data: await db.export(), errors };
}
