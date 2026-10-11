/**
 * Datenbankzugriff: SQLite läuft im Web-Worker (worker.js). Diese Klasse bietet eine Promise-API
 * und liest die Datenbankstruktur (Tabellen, Spalten, Fremdschlüssel) für Compiler, Code-Vervollständigung
 * und Schema-Ansicht. parseDatabaseStructure ist aus src/client/sqljs-worker/DatabaseTools.ts übernommen.
 */
import type { ColumnStructure, DatabaseStructure, QueryResult, TableStructure } from "../../src/client/sqljs-worker/DatabaseTools.js";

export type { DatabaseStructure, QueryResult, TableStructure, ColumnStructure };

type Pending = { resolve: (v: any) => void, reject: (e: any) => void };

export class PadDatabase {

    private worker: Worker;
    private nextId = 0;
    private pending = new Map<number, Pending>();
    private queue: Promise<any> = Promise.resolve();

    /** wird vom SymbolResolver des Compilers gelesen */
    databaseStructure: DatabaseStructure = { tables: [] };

    constructor() {
        this.worker = new Worker("worker.js");
        this.worker.onmessage = (ev) => {
            const p = this.pending.get(ev.data.id);
            if (!p) return;
            this.pending.delete(ev.data.id);
            if (ev.data.error != null) p.reject(ev.data.error);
            else p.resolve(ev.data);
        };
        this.worker.onerror = (ev) => {
            console.error("Worker-Fehler", ev);
            this.pending.forEach(p => p.reject("Die Datenbank-Engine konnte nicht gestartet werden."));
            this.pending.clear();
        };
    }

    private post(msg: any, transfer: Transferable[] = []): Promise<any> {
        // Anfragen strikt nacheinander ausführen
        const run = () => new Promise<any>((resolve, reject) => {
            const id = this.nextId++;
            this.pending.set(id, { resolve, reject });
            this.worker.postMessage({ ...msg, id }, transfer);
        });
        const p = this.queue.then(run, run);
        this.queue = p.catch(() => { });
        return p;
    }

    async open(buffer: Uint8Array | null): Promise<void> {
        // Kopie übergeben, damit der Aufrufer seinen Puffer behält
        const copy = buffer ? buffer.slice() : null;
        await this.post({ action: "open", buffer: copy }, copy ? [copy.buffer] : []);
        await this.exec("PRAGMA foreign_keys = ON;");
        await this.refreshStructure();
    }

    async exec(sql: string): Promise<QueryResult[]> {
        const data = await this.post({ action: "exec", sql });
        return data.results;
    }

    async export(): Promise<Uint8Array> {
        const data = await this.post({ action: "export" });
        return data.buffer;
    }

    async refreshStructure(): Promise<DatabaseStructure> {
        const tables = await this.exec(`SELECT name, sql, type FROM sqlite_master WHERE (type='table' or type='view') and name not like 'sqlite_%';`);
        const values = tables[0]?.values ?? [];
        if (values.length == 0) {
            this.databaseStructure = { tables: [] };
            return this.databaseStructure;
        }
        const types = values.map(v => v[2]);
        let sql1 = "";
        values.forEach(v => sql1 += `PRAGMA table_info("${v[0]}");\nPRAGMA foreign_key_list("${v[0]}");\nselect count(*) from "${v[0]}";\n\n`);
        try {
            const columns = await this.exec(sql1);
            this.databaseStructure = this.parseDatabaseStructure(tables, columns, types);
        } catch (e) {
            console.log(e);
            this.databaseStructure = { tables: [] };
        }
        return this.databaseStructure;
    }

    private parseDatabaseStructure(tables: QueryResult[], columns: QueryResult[], types: ("table" | "view")[]): DatabaseStructure {
        const structure: DatabaseStructure = { tables: [] };
        const tableNameToStructureMap: Map<string, TableStructure> = new Map();

        let index = 0;
        for (let i = 0; i < tables[0].values.length; i++) {
            const tableName = tables[0].values[i][0];
            const tableSQL = <string>tables[0].values[i][1] ?? "";

            const tableStructure: TableStructure = { name: tableName, size: 0, completeSQL: tableSQL, columns: [], type: types[i] };
            tableNameToStructureMap.set(tableName.toLocaleLowerCase(), tableStructure);
            structure.tables.push(tableStructure);

            // table_info liefert bei Tabellen ohne Spalten kein Ergebnis -> defensiv lesen
            let columnArray: any[][] = [];
            if (columns[index] && columns[index].columns[0] == "cid") {
                columnArray = columns[index].values;
                index++;
            }
            let foreignKeyList: any[][] = null;
            if (columns.length > index && columns[index].columns[0] == "id") {
                foreignKeyList = columns[index].values;
                index++;
            }
            tableStructure.size = columns[index]?.values?.[0]?.[0] ?? 0;
            index++;

            columnArray.forEach(c => {
                const name: string = c[1];
                const type: string = c[2] ?? "";
                const isPrimaryKey: boolean = c[5] != 0;
                let enumValues: string[] = [];
                if (type.indexOf("Enum") >= 0) {
                    const match = tableSQL.match(new RegExp(`"${name}" ${type} .* check\\("${name}" in \\((.*)\\)\\)`));
                    if (match != null) enumValues = match[1].split(", ");
                }
                const cs: ColumnStructure = {
                    name, isPrimaryKey,
                    isAutoIncrement: isPrimaryKey && tableSQL.toLowerCase().indexOf("autoincrement") >= 0,
                    completeTypeSQL: type, enumValues, table: tableStructure, typeLengths: [],
                    defaultValue: c[4], notNull: c[3] == 1
                };
                if (foreignKeyList != null) {
                    const fk = foreignKeyList.find(f => (f[3] + "").toLocaleLowerCase() == name.toLocaleLowerCase());
                    if (fk != null) cs.referencesRawData = fk;
                }
                tableStructure.columns.push(cs);
            });
        }

        for (const ts of structure.tables) {
            for (const cs of ts.columns) {
                if (cs.referencesRawData != null) {
                    const table = tableNameToStructureMap.get((cs.referencesRawData[2] + "").toLocaleLowerCase());
                    if (table == null) continue;
                    const to = cs.referencesRawData[4];
                    cs.references = to == null
                        ? table.columns.find(c => c.isPrimaryKey)
                        : table.columns.find(c => c.name.toLocaleLowerCase() == (to + "").toLocaleLowerCase());
                }
            }
        }
        return structure;
    }
}
