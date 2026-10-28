/**
 * QPad – SQL für das iPad. Hauptprogramm.
 * Alles läuft lokal im Browser: SQLite (WebAssembly), Compiler und Editor. Kein Login, kein Server-Code.
 */
import type { EditorState } from "@codemirror/state";
import { TokenType } from "../../src/client/compiler/lexer/Token.js";
import type { SQLStatement } from "../../src/client/compiler/parser/Parser.js";
import { StatementCleaner } from "../../src/client/compiler/parser/StatementCleaner.js";
import type { SQLType } from "../../src/client/compiler/parser/SQLTypes.js";
import { PadDatabase, QueryResult, TableStructure } from "./db.js";
import { SqlEditor } from "./editor.js";
import { openFile } from "./importers.js";
import {
    lastProjectId, LocalStore, newProject, Project, rememberLastProject, safeFileName, serializeProject
} from "./project.js";
import { highlightToHtml } from "./sqlLanguage.js";
import { helpFor } from "./symbolHelp.js";
import { translateSqliteError } from "./translate.js";
import { icon } from "./icons.js";
import { loadLernpfadUrl, nameFromUrl, readLernpfadFile, titleOf, vorlageOf, withStorageShim } from "./lernpfad.js";

type View = "code" | "lernpfad" | "tabellen";

/** Themes wie in JPad (bg/fg: Farben des kleinen Vorschau-Felds im Menü) */
const SKINS: { id: string, label: string, icon: string, bg: string, fg: string }[] = [
    { id: "default", label: "Standard", icon: "palette", bg: "#f4f5f7", fg: "#1f5fbf" },
    { id: "kiosk", label: "Kiosk – Farben des Demo-Lernpfads „Der Pausenkiosk“", icon: "pretzel", bg: "#f9e2cf", fg: "#b4521a" },
    { id: "hund", label: "Hund – Farben des JPad-Lernpfads „Bello lernt Java“", icon: "dog", bg: "#e5f3ea", fg: "#1f8a6a" },
    { id: "schaf", label: "Schaf – Farben des JPad-Lernpfads „Der Schaf-Konstruktor“", icon: "sheep", bg: "#fdebdd", fg: "#e05d26" },
    { id: "flat", label: "Flach – klare Linien in Weiß und Blau", icon: "hacker", bg: "#FFFFFF", fg: "#0050F0" },
    { id: "hacker", label: "Hacker – Neon-Grün, feine Linien, spitze Ecken", icon: "hacker", bg: "#FFFFFF", fg: "#00B86E" },
    { id: "pink", label: "Pink – wie Hacker, aber in Pink", icon: "hacker", bg: "#FFFFFF", fg: "#E0109F" },
];
type LpMode = "normal" | "wide" | "full" | "hidden";
/** Demo-Lernpfad (liegt im Paket unter learn/demo) */
const DEMO_LERNPFAD = "learn/demo/Lernpfad-Pausenkiosk.html";

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;
const esc = (s: any) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

type Template = { name: string, file: string, description?: string };

class App {

    db = new PadDatabase();
    editor: SqlEditor;
    project: Project;
    /** Editor-Zustände je Skript (eigene Undo-Historie) */
    states: (EditorState | null)[] = [];
    /** Schnappschüsse der Datenbank für "Datenbankänderung rückgängig" */
    dbUndo: Uint8Array[] = [];
    saveTimer: any = null;
    busy = false;
    templates: Template[] = [];
    /** Layout wie JPad: "split" (quer, nebeneinander) oder "tabs" (hochkant, Reiter unten) */
    view: View = "code";
    private layoutMq = matchMedia("(min-width: 900px) and (min-aspect-ratio: 1/1)");
    private lpStateTimer: any = null;

    async start() {
        this.setupViewport();
        this.editor = new SqlEditor($("#editor"), this.db, {
            onRun: all => this.run(all),
            onChange: text => {
                this.project.scripts[this.project.activeScript].text = text;
                this.touch();
            },
            onStatus: (html, level) => {
                const s = $("#status");
                s.innerHTML = html;
                s.className = "status status-" + level;
            },
            onCompiled: () => this.updateRunButton()
        });

        this.bindUi();
        this.buildSymbolBar();
        this.loadTemplates();

        try { (navigator as any).storage?.persist?.(); } catch (e) { }

        // Projekt aus URL (für Lehrkräfte: ?projekt=datei.sqlprojekt.json oder ?vorlage=datenbank.sqLite,
        // mit Lernpfad: ?lernpfad=seite.html|.zip|.sqlprojekt.json, auch kombiniert)
        const params = new URLSearchParams(location.search);
        const urlLernpfad = params.get("lernpfad");
        const urlProject = urlLernpfad ? null : params.get("projekt"), urlTemplate = urlLernpfad ? null : params.get("vorlage");
        if (urlProject || urlTemplate) history.replaceState(null, "", location.pathname);

        let project: Project | undefined;
        try {
            const id = lastProjectId();
            if (id) project = await LocalStore.load(id);
            if (!project) project = (await LocalStore.list())[0];
        } catch (e) {
            console.warn("Lokaler Speicher nicht verfügbar", e);
        }

        if (urlLernpfad) {
            if (project) this.project = project;
            const ok = await this.openFromLink({
                lernpfad: urlLernpfad, projekt: params.get("projekt"), vorlage: params.get("vorlage"),
                fresh: params.get("neu") != null
            });
            if (!ok && !this.project) await this.setProject(project ?? newProject("Mein erstes Projekt"));
            else if (!ok) await this.setProject(this.project);
        } else if (urlProject) {
            await this.openFromUrl(urlProject);
        } else if (urlTemplate) {
            await this.setProject(project ?? newProject());
            await this.createProjectFromTemplate({ name: urlTemplate.replace(/\.[^.]*$/, ""), file: urlTemplate });
        } else if (project) {
            await this.setProject(project);
        } else {
            // Allererster Start: Demo-Lernpfad öffnen und Willkommen zeigen (wie JPad)
            const ok = await this.openFromLink({ lernpfad: DEMO_LERNPFAD, fresh: true }, true);
            if (!ok) await this.setProject(newProject("Mein erstes Projekt"));
            this.showWelcome();
        }
        $("#loading").remove();
    }

    // ------------------------------------------------------------------ Projekt

    async setProject(p: Project) {
        this.project = p;
        this.dbUndo = [];
        this.updateUndoButtons();
        this.states = p.scripts.map(() => null);
        this.showWait("Datenbank wird geöffnet …");
        try {
            await this.db.open(p.database);
        } catch (e) {
            alert("Die Datenbank konnte nicht geöffnet werden: " + e);
            await this.db.open(null);
        }
        this.hideWait();
        rememberLastProject(p.id);
        this.renderProjectHeader();
        this.renderTabs();
        this.switchScript(p.activeScript, true);
        this.renderSchema();
        this.clearResults();
        this.showLernpfad();
        if (p.lernpfadHtml) this.showLernpfadLayout();
        else this.setView("code");
        await this.saveLocal();
    }

    /** markiert das Projekt als geändert und speichert verzögert */
    touch() {
        this.project.modified = Date.now();
        this.renderSaveState();
        clearTimeout(this.saveTimer);
        this.saveTimer = setTimeout(() => this.saveLocal(), 700);
    }

    async saveLocal() {
        clearTimeout(this.saveTimer);
        try {
            await LocalStore.save(this.project);
            $("#savedLocal").textContent = "lokal gesichert";
        } catch (e) {
            console.warn(e);
            $("#savedLocal").textContent = "⚠︎ lokale Sicherung nicht möglich";
        }
    }

    renderProjectHeader() {
        $("#projectName").textContent = this.project.name;
        document.title = this.project.name + " – QPad";
        this.renderSaveState();
    }

    renderSaveState() {
        const dirty = this.project.modified > this.project.downloaded;
        $("#btnDownload").classList.toggle("dirty", dirty);
        $("#btnDownload").title = dirty ? "Projekt herunterladen – Änderungen seit dem letzten Download" : "Projekt herunterladen";
    }

    async downloadProject() {
        await this.flushDatabase();
        const json = serializeProject(this.project);
        const fileName = safeFileName(this.project.name) + ".sqlprojekt.json";
        this.downloadBlob(new Blob([json], { type: "application/json" }), fileName);
        this.project.downloaded = Date.now();
        this.renderSaveState();
        this.saveLocal();
        this.toast(`„${fileName}“ wird heruntergeladen. Auf dem iPad findest du sie in der App „Dateien“ unter „Downloads“.`);
    }

    async shareProject() {
        await this.flushDatabase();
        const json = serializeProject(this.project);
        const file = new File([json], safeFileName(this.project.name) + ".sqlprojekt.json", { type: "application/json" });
        const nav: any = navigator;
        if (nav.canShare && nav.canShare({ files: [file] })) {
            try {
                await nav.share({ files: [file], title: this.project.name });
                this.project.downloaded = Date.now();
                this.renderSaveState();
                this.saveLocal();
            } catch (e) { /* abgebrochen */ }
        } else {
            this.downloadProject();
        }
    }

    downloadBlob(blob: Blob, fileName: string) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url; a.download = fileName; a.rel = "noopener";
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 60000);
    }

    /** aktuellen Datenbankstand ins Projekt übernehmen */
    async flushDatabase() {
        this.project.database = await this.db.export();
    }

    // ------------------------------------------------------------------ Skripte (Tabs)

    renderTabs() {
        const tabs = $("#scriptTabs");
        tabs.innerHTML = "";
        this.project.scripts.forEach((s, i) => {
            const b = document.createElement("button");
            b.className = "tab" + (i == this.project.activeScript ? " active" : "");
            b.textContent = s.name;
            b.onclick = () => i == this.project.activeScript ? this.scriptMenu(i) : this.switchScript(i);
            tabs.appendChild(b);
        });
        const add = document.createElement("button");
        add.className = "tab tab-add";
        add.textContent = "+";
        add.title = "Neues Skript";
        add.onclick = () => this.addScript();
        tabs.appendChild(add);
    }

    switchScript(i: number, force = false) {
        if (!force && i == this.project.activeScript) return;
        if (!force) this.states[this.project.activeScript] = this.editor.getState();
        this.project.activeScript = i;
        const st = this.states[i] ?? this.editor.createState(this.project.scripts[i].text);
        this.editor.setState(st);
        this.renderTabs();
        if (!force) this.touch();
    }

    addScript() {
        let n = this.project.scripts.length + 1;
        while (this.project.scripts.some(s => s.name == "Skript " + n)) n++;
        this.project.scripts.push({ name: "Skript " + n, text: "" });
        this.states.push(null);
        this.switchScript(this.project.scripts.length - 1);
        this.editor.focus();
    }

    scriptMenu(i: number) {
        const s = this.project.scripts[i];
        this.sheet("Skript „" + s.name + "“", [
            {
                label: "Umbenennen", icon: "✎", action: () => {
                    const name = prompt("Neuer Name des Skripts:", s.name);
                    if (name && name.trim()) { s.name = name.trim(); this.renderTabs(); this.touch(); }
                }
            },
            {
                label: "Als .sql-Datei herunterladen", icon: "⬇", action: () =>
                    this.downloadBlob(new Blob([s.text], { type: "text/plain" }), safeFileName(s.name) + ".sql")
            },
            {
                label: "Skript löschen", icon: "🗑", danger: true, disabled: this.project.scripts.length <= 1, action: () => {
                    if (!confirm(`Skript „${s.name}“ wirklich löschen?`)) return;
                    this.project.scripts.splice(i, 1);
                    this.states.splice(i, 1);
                    this.project.activeScript = Math.min(this.project.activeScript, this.project.scripts.length - 1);
                    this.switchScript(this.project.activeScript, true);
                    this.touch();
                }
            }
        ]);
    }

    // ------------------------------------------------------------------ Ausführen

    updateRunButton() {
        const st = this.editor.getSelectedStatements();
        const runnable = st.some(s => !s.hasErrors && s.ast?.type != TokenType.omittedeStatement);
        $("#btnRun").classList.toggle("disabled", !runnable);
    }

    async run(all: boolean) {
        if (this.busy) return;
        this.editor.compileNow();
        let statements = (all ? this.editor.getAllStatements() : this.editor.getSelectedStatements())
            .filter(st => st.ast != null && st.ast.type != TokenType.omittedeStatement);
        if (statements.length == 0) {
            this.toast("Es gibt keine Anweisung zum Ausführen. Setze den Cursor in eine SQL-Anweisung.");
            return;
        }

        this.busy = true;
        $("#btnRun").classList.add("running");
        const out: HTMLElement[] = [];
        let modified = false;
        const t0 = performance.now();

        try {
            const modifying = statements.some(st => isModifying(st));
            if (modifying) {
                this.dbUndo.push(await this.db.export());
                if (this.dbUndo.length > 15) this.dbUndo.shift();
            }

            let schemaChanged = false;
            for (let i = 0; i < statements.length; i++) {
                if (statements[i].hasErrors && schemaChanged) {
                    // Schema wurde durch vorherige Anweisung geändert -> restliche Anweisungen mit neuem Schema erneut prüfen
                    await this.db.refreshStructure();
                    this.editor.compileNow();
                    schemaChanged = false;
                    const all = this.editor.getAllStatements();
                    for (let j = i; j < statements.length; j++) {
                        const old = statements[j];
                        statements[j] = all.find(s => s.from.line == old.from.line && s.from.column == old.from.column) ?? old;
                    }
                }
                const st = statements[i];
                st.sql = this.editor.sqlOf(st);
                if (st.hasErrors) {
                    const err = this.editor.module.getSortedAndFilteredErrors().find(e => e.level == "error" &&
                        e.position.line >= st.from.line && e.position.line <= st.to.line);
                    out.push(this.renderError(st, (err ? `Zeile ${err.position.line}: ${err.text} – ` : "") + "Die Anweisung wurde nicht ausgeführt."));
                    continue;
                }
                try {
                    if (st.ast.type == TokenType.keywordSelect) {
                        let sql = st.sql.trim().replace(/;+\s*$/, "");
                        if ((st.ast as any).limitNode == null) sql += "\nlimit 100000";
                        const results = await this.db.exec(sql);
                        out.push(this.renderResult(st.sql, results.pop() ?? null, st.resultTypes));
                    } else {
                        const sql = new StatementCleaner().clean(st);
                        await this.db.exec(sql);
                        modified = true;
                        if (!isDataOnly(st)) schemaChanged = true;
                        const changes = (await this.db.exec("select changes()"))[0]?.values?.[0]?.[0] ?? 0;
                        out.push(this.renderMessage(st, changes));
                    }
                } catch (e) {
                    out.push(this.renderError(st, translateSqliteError(String(e))));
                }
            }
        } finally {
            this.busy = false;
            $("#btnRun").classList.remove("running");
        }

        if (modified) {
            await this.db.refreshStructure();
            this.renderSchema();
            this.editor.compileNow();
            await this.flushDatabase();
            this.touch();
        } else if (statements.some(isModifying)) {
            this.dbUndo.pop();
        }
        this.updateUndoButtons();

        const ms = Math.round(performance.now() - t0);
        this.showResults(out, [], ms);
    }

    renderError(st: SQLStatement, msg: string): HTMLElement {
        const d = document.createElement("div");
        d.className = "result-block error";
        d.innerHTML = `<div class="result-sql">${highlightToHtml(oneLine(st.sql ?? ""))}</div><div class="result-msg">✗ ${esc(msg)}</div>`;
        d.onclick = () => this.editor.revealStatement(st);
        return d;
    }

    renderMessage(st: SQLStatement, changes: number): HTMLElement {
        const div = document.createElement("div");
        div.className = "result-block message";
        const type = st.ast.type;
        let text: string;
        const n = `${changes} ${changes == 1 ? "Datensatz" : "Datensätze"}`;
        switch (type) {
            case TokenType.keywordInsert: text = `✓ ${n} eingefügt.`; break;
            case TokenType.keywordUpdate: text = `✓ ${n} geändert.`; break;
            case TokenType.keywordDelete: text = `✓ ${n} gelöscht.`; break;
            case TokenType.keywordCreate: text = "✓ Tabelle angelegt."; break;
            case TokenType.keywordDrop: text = "✓ Gelöscht."; break;
            case TokenType.keywordAlter: text = "✓ Tabellenstruktur geändert."; break;
            case TokenType.keywordView: text = "✓ Sicht (View) angelegt."; break;
            default: text = "✓ Ausgeführt.";
        }
        div.innerHTML = `<div class="result-sql">${highlightToHtml(oneLine(st.sql))}</div><div class="result-msg">${text}</div>`;
        return div;
    }

    renderResult(sql: string, result: QueryResult | null, types: SQLType[] | null): HTMLElement {
        const block = document.createElement("div");
        block.className = "result-block";
        const rows = result?.values ?? [];
        const cols = result?.columns ?? [];
        const isBool = (types ?? []).map(t => ["boolean", "tinyint(1)"].includes(String(t)));
        const PAGE = 100;
        let page = 0;

        const head = document.createElement("div");
        head.className = "result-head";
        head.innerHTML = `<div class="result-sql">${highlightToHtml(oneLine(sql))}</div>
            <div class="result-count">${result == null ? "leeres Ergebnis" : rows.length + (rows.length == 1 ? " Datensatz" : " Datensätze")}</div>`;
        block.appendChild(head);

        const wrap = document.createElement("div");
        wrap.className = "table-wrap";
        block.appendChild(wrap);

        const pager = document.createElement("div");
        pager.className = "pager";

        const renderPage = () => {
            const slice = rows.slice(page * PAGE, page * PAGE + PAGE);
            let html = "<table><thead><tr><th class='rownum'>#</th>" + cols.map(c => `<th>${esc(c)}</th>`).join("") + "</tr></thead><tbody>";
            slice.forEach((r, i) => {
                html += `<tr><td class="rownum">${page * PAGE + i + 1}</td>` + r.map((v, j) => {
                    if (v === null) return `<td class="null">NULL</td>`;
                    if (isBool[j]) return `<td class="bool">${v == 1 ? "true" : "false"}</td>`;
                    if (typeof v == "number") return `<td class="num">${v}</td>`;
                    if (v instanceof Uint8Array) return `<td class="null">[Binärdaten]</td>`;
                    return `<td>${esc(v)}</td>`;
                }).join("") + "</tr>";
            });
            html += "</tbody></table>";
            if (result == null || cols.length == 0) html = "<div class='empty'>Die Abfrage lieferte keine Datensätze.</div>";
            wrap.innerHTML = html;
            const pages = Math.ceil(rows.length / PAGE);
            pager.style.display = pages > 1 ? "" : "none";
            pager.innerHTML = `<button ${page == 0 ? "disabled" : ""} data-d="-1">‹ zurück</button>
                <span>${page * PAGE + 1}–${Math.min(rows.length, (page + 1) * PAGE)} von ${rows.length}</span>
                <button ${page >= pages - 1 ? "disabled" : ""} data-d="1">weiter ›</button>`;
            pager.querySelectorAll("button").forEach(b => b.onclick = () => { page += +b.dataset.d; renderPage(); wrap.scrollTop = 0; });
        };
        renderPage();
        block.appendChild(pager);
        return block;
    }

    showResults(blocks: HTMLElement[], errors: { st: SQLStatement, msg: string }[], ms: number) {
        const area = $("#results");
        area.innerHTML = "";
        for (const e of errors) {
            const d = document.createElement("div");
            d.className = "result-block error";
            d.innerHTML = `<div class="result-sql">${highlightToHtml(oneLine(e.st.sql ?? ""))}</div><div class="result-msg">✗ ${esc(e.msg)}</div>`;
            d.onclick = () => this.editor.revealStatement(e.st);
            area.appendChild(d);
        }
        blocks.forEach(b => area.appendChild(b));
        const info = document.createElement("div");
        info.className = "result-time";
        info.textContent = `ausgeführt in ${ms} ms`;
        area.appendChild(info);
        area.scrollTop = 0;
    }

    clearResults() {
        $("#results").innerHTML = `<div class="empty">Tippe auf <b>▶ Ausführen</b>, um die Anweisung an der Cursorposition auszuführen.<br>
        Mit Tastatur: <kbd>⇧</kbd>+<kbd>↩</kbd> oder <kbd>⌘</kbd>+<kbd>↩</kbd>.</div>`;
    }

    async showTableContent(table: TableStructure) {
        const sql = `select * from "${table.name}";`;
        try {
            const res = await this.db.exec(sql + "");
            this.showResults([this.renderResult(sql, res.pop() ?? null, null)], [], 0);
        } catch (e) {
            this.toast(String(e));
        }
        this.closeSidebarIfOverlay();
    }

    updateUndoButtons() {
        const empty = this.dbUndo.length == 0;
        $("#btnDbUndo").classList.toggle("disabled", empty);
        ($("#drawerDbUndo") as HTMLButtonElement).disabled = empty;
    }

    async undoDatabase() {
        const snap = this.dbUndo.pop();
        if (!snap) { this.toast("Es gibt noch keine Datenänderung (insert, update, delete, create …), die rückgängig gemacht werden kann."); return; }
        await this.db.open(snap);
        await this.flushDatabase();
        this.renderSchema();
        this.editor.compileNow();
        this.touch();
        this.updateUndoButtons();
        this.toast("Die letzte Datenbankänderung wurde rückgängig gemacht.");
    }

    async resetDatabase() {
        if (!confirm(`Datenbank auf den Ausgangszustand („${this.project.templateName}“) zurücksetzen? Alle Änderungen an den Daten gehen verloren. Deine Skripte bleiben erhalten.`)) return;
        this.dbUndo.push(await this.db.export());
        await this.db.open(this.project.template);
        await this.flushDatabase();
        this.renderSchema();
        this.editor.compileNow();
        this.touch();
        this.updateUndoButtons();
        this.toast("Die Datenbank wurde zurückgesetzt.");
    }

    // ------------------------------------------------------------------ Schema-Ansicht

    renderSchema() {
        const tree = $("#schemaTree");
        const tables = this.db.databaseStructure.tables;
        $("#dbName").textContent = this.project.templateName;
        if (tables.length == 0) {
            tree.innerHTML = `<div class="empty small">Die Datenbank ist leer. Lege mit <code>create table</code> eine Tabelle an oder lade eine Vorlage.</div>`;
            return;
        }
        tree.innerHTML = "";
        const sorted = tables.slice().sort((a, b) => (a.type == b.type ? 0 : a.type == "table" ? -1 : 1) || a.name.localeCompare(b.name));
        for (const t of sorted) {
            const el = document.createElement("div");
            el.className = "tbl";
            const cols = t.columns.map(c => {
                const fk = c.references ? `<span class="fk" title="Fremdschlüssel">→ ${esc(c.references.table.name)}.${esc(c.references.name)}</span>` : "";
                return `<button class="col" data-ins="${esc(c.name)}">${c.isPrimaryKey ? "<span class='pk' title='Primärschlüssel'>🔑</span>" : "<span class='pk'></span>"}
                    <span class="cname">${esc(c.name)}</span><span class="ctype">${esc(c.completeTypeSQL.toLowerCase())}</span>${fk}</button>`;
            }).join("");
            el.innerHTML = `<div class="tbl-head">
                    <button class="toggle" aria-label="aufklappen">▸</button>
                    <button class="tname" data-ins="${esc(t.name)}">${esc(t.name)}${t.type == "view" ? " <span class='tag'>View</span>" : ""}</button>
                    <span class="tsize">${t.size}</span>
                    <button class="show" title="Inhalt anzeigen">Inhalt</button>
                </div><div class="cols">${cols}</div>`;
            const toggle = () => el.classList.toggle("open");
            (el.querySelector(".toggle") as HTMLElement).onclick = toggle;
            (el.querySelector(".show") as HTMLElement).onclick = () => this.showTableContent(t);
            el.querySelectorAll<HTMLElement>("[data-ins]").forEach(b => b.onclick = () => {
                if (b.classList.contains("tname") && !el.classList.contains("open")) { toggle(); return; }
                if (this.isTabs()) this.setView("code");
                this.editor.insert(b.dataset.ins);
            });
            tree.appendChild(el);
        }
    }

    toggleSidebar(show?: boolean) {
        const app = $("#app");
        const open = show ?? !app.classList.contains("sidebar-open");
        app.classList.toggle("sidebar-open", open);
        app.classList.toggle("sidebar-closed", !open);
    }
    closeSidebarIfOverlay() {
        if (this.isTabs()) this.setView("code");
    }

    // ------------------------------------------------------------------ Menüs & Dialoge

    // ------------------------------------------------------------------ Menü (Schublade, wie in JPad)

    openDrawer() {
        this.saveLocal();
        this.renderDrawer();
        $("#app").classList.add("drawer-open");
        $("#drawer").removeAttribute("inert");
        $("#drawerClose").focus({ preventScroll: true });
    }

    closeDrawer() {
        $("#app").classList.remove("drawer-open");
        $("#drawer").setAttribute("inert", "");
    }

    async renderDrawer() {
        $("#drawerDbName").textContent = this.project.templateName;
        ($("#drawerDbUndo") as HTMLButtonElement).disabled = this.dbUndo.length == 0;
        $("#drawerShare").style.display = (navigator as any).canShare ? "" : "none";
        $("#drawerLpRemove").style.display = this.project.lernpfadHtml ? "" : "none";
        $("#drawerLpAdd").querySelector("span").textContent = this.project.lernpfadHtml ? "Lernpfad ersetzen" : "Lernpfad einbetten";
        this.renderSettings();
        let projects: Project[] = [];
        try { projects = await LocalStore.list(); } catch (e) { }
        const ul = $("#projectList");
        ul.innerHTML = "";
        const fmt = new Intl.DateTimeFormat("de-DE", { dateStyle: "short", timeStyle: "short" });
        for (const p of projects) {
            const isCurrent = p.id == this.project.id;
            const li = document.createElement("li");
            li.className = "qp-projectitem" + (isCurrent ? " is-current" : "");
            li.innerHTML = `
                <button class="qp-projectitem-open">${icon(isCurrent ? "check" : "folder")}
                    <span><span class="qp-projectitem-name">${esc(p.name)}</span>
                    <span class="qp-projectitem-date">geändert ${fmt.format(new Date(p.modified))}</span></span>
                </button>
                <button class="iconbtn qp-projectitem-del" aria-label="Projekt „${esc(p.name)}“ löschen">${icon("trash")}</button>`;
            (li.querySelector(".qp-projectitem-open") as HTMLElement).onclick = async () => {
                this.closeDrawer();
                if (!isCurrent) { await this.saveLocal(); await this.setProject(p); }
            };
            (li.querySelector(".qp-projectitem-del") as HTMLElement).onclick = () => this.deleteProject(p);
            ul.appendChild(li);
        }
    }

    async deleteProject(p: Project) {
        const unsaved = p.modified > p.downloaded;
        if (!confirm(`„${p.name}“ von diesem Gerät löschen?\n\n` + (unsaved
            ? "Das Projekt wurde seit der letzten Änderung nicht heruntergeladen und ist danach verloren."
            : "Deine heruntergeladene Projektdatei bleibt erhalten."))) return;
        await LocalStore.remove(p.id);
        if (p.id == this.project.id) {
            const rest = await LocalStore.list();
            await this.setProject(rest[0] ?? newProject("Mein Projekt"));
        }
        this.renderDrawer();
    }

    renameProject() {
        const n = prompt("Name des Projekts:", this.project.name);
        if (n && n.trim() && n.trim() != this.project.name) {
            this.project.name = n.trim();
            this.renderProjectHeader();
            this.touch();
        }
    }

    // ------------------------------------------------------------------ Darstellung

    getThemeChoice(): string {
        try { return localStorage.getItem("qpad.theme") || "auto"; } catch (e) { return "auto"; }
    }
    setThemeChoice(c: string) {
        try { localStorage.setItem("qpad.theme", c); } catch (e) { }
        applyTheme();
        this.renderSettings();
    }
    getFontSize(): number {
        try { return parseInt(localStorage.getItem("qpad.fontSize") || "") || 16; } catch (e) { return 16; }
    }
    setFontSize(size: number) {
        size = Math.max(12, Math.min(26, size));
        try { localStorage.setItem("qpad.fontSize", String(size)); } catch (e) { }
        document.documentElement.style.setProperty("--editor-font", size + "px");
        this.editor?.view.requestMeasure();
        this.renderSettings();
    }
    getSkin(): string {
        try { const k = localStorage.getItem("qpad.skin"); return SKINS.some(x => x.id == k) ? k : "default"; } catch (e) { return "default"; }
    }
    setSkin(k: string) {
        try { localStorage.setItem("qpad.skin", k); } catch (e) { }
        applyTheme();
        this.renderSettings();
    }
    buildSkinPicker() {
        const box = $("#skinPicker");
        box.innerHTML = SKINS.map(k => `<button data-skin-choice="${k.id}" aria-label="Theme ${esc(k.label)}" title="${esc(k.label)}"
            style="--sw-bg:${k.bg};--sw-fg:${k.fg}"><span class="qp-skin-swatch">${icon(k.icon)}</span></button>`).join("");
        box.querySelectorAll<HTMLElement>("[data-skin-choice]").forEach(b => b.onclick = () => this.setSkin(b.dataset.skinChoice));
    }
    renderSettings() {
        const c = this.getThemeChoice();
        const k = this.getSkin();
        document.querySelectorAll<HTMLElement>("[data-skin-choice]").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.skinChoice == k)));
        document.querySelectorAll<HTMLElement>("[data-theme-choice]").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.themeChoice == c)));
        $("#fontSizeLabel").textContent = this.getFontSize() + " pt";
    }

    async newProjectDialog() {
        await this.ensureTemplates();
        const name = prompt("Name des neuen Projekts:", "Projekt " + new Date().toLocaleDateString("de-DE"));
        if (!name || !name.trim()) return;
        this.sheet("Womit soll „" + name.trim() + "“ starten?", [
            { label: "Leere Datenbank", icon: "○", action: async () => { await this.saveLocal(); await this.setProject(newProject(name.trim())); } },
            ...this.templates.map(t => ({
                label: t.name, hint: t.description, icon: "🗄",
                action: async () => { await this.saveLocal(); await this.setProject(newProject(name.trim())); await this.createProjectFromTemplate(t); }
            }))
        ]);
    }

    async templateDialog() {
        if (!(await this.ensureTemplates())) {
            alert(this.templateError || "Auf dem Server sind keine Vorlagen hinterlegt (vorlagen/vorlagen.json).");
            return;
        }
        this.sheet("Vorlage laden", this.templates.map(t => ({
            label: t.name, hint: t.description, icon: "🗄",
            action: async () => {
                if (this.db.databaseStructure.tables.length > 0 &&
                    !confirm(`Die aktuelle Datenbank wird durch „${t.name}“ ersetzt. Deine Skripte bleiben erhalten. Fortfahren?`)) return;
                await this.createProjectFromTemplate(t);
            }
        })), "Die Datenbank des aktuellen Projekts wird ersetzt.");
    }

    templateError = "";

    /** Lädt die Vorlagenliste; bei Fehlern wird beim nächsten Öffnen erneut versucht */
    async loadTemplates(): Promise<boolean> {
        const url = new URL("vorlagen/vorlagen.json", location.href).href;
        try {
            const r = await fetch(url, { cache: "no-store" });
            if (!r.ok) throw new Error(`Der Server antwortet mit HTTP ${r.status}.`);
            const list = await r.json();
            if (!Array.isArray(list)) throw new Error("Die Datei ist keine Vorlagenliste.");
            this.templates = list;
            this.templateError = "";
            return true;
        } catch (e: any) {
            this.templateError = `Die Vorlagenliste konnte nicht geladen werden:\n${url}\n\n${e?.message ?? e}`;
            console.warn(this.templateError);
            return false;
        }
    }

    async ensureTemplates(): Promise<boolean> {
        if (this.templates.length > 0) return true;
        this.showWait("Lade Vorlagen …");
        const ok = await this.loadTemplates();
        this.hideWait();
        return ok && this.templates.length > 0;
    }

    async createProjectFromTemplate(t: Template & { url?: string }) {
        this.showWait(`Lade „${t.name}“ …`);
        try {
            const r = await fetch(t.url ?? "vorlagen/" + t.file);
            if (!r.ok) throw new Error(`Die Vorlage konnte nicht geladen werden (HTTP ${r.status}).`);
            const bytes = new Uint8Array(await r.arrayBuffer());
            const opened = await openFile(bytes, t.file, this.db, msg => this.showWait(msg));
            if (opened.kind != "database") throw new Error("Die Vorlage ist keine Datenbank.");
            await this.useDatabase(opened.data, t.name, opened.errors);
        } catch (e: any) {
            alert(e?.message ?? String(e));
            await this.db.open(this.project.database);
        } finally {
            this.hideWait();
        }
    }

    async useDatabase(data: Uint8Array, name: string, errors: string[]) {
        // Eine neu geladene Datenbank ersetzt alles – die Datenschritte davor gelten nicht mehr
        this.dbUndo = [];
        await this.db.open(data);
        this.project.template = data.slice();
        this.project.templateName = name;
        await this.flushDatabase();
        this.renderSchema();
        this.editor.compileNow();
        this.touch();
        this.updateUndoButtons();
        if (errors.length > 0) {
            console.warn(errors);
            alert(`Beim Import sind ${errors.length} Fehler aufgetreten. Die übrigen Daten wurden übernommen.\n\nErster Fehler:\n${errors[0]}`);
        } else {
            this.toast(`Datenbank „${name}“ geladen.`);
        }
    }

    async openFromUrl(url: string) {
        this.showWait("Projekt wird geladen …");
        try {
            const r = await fetch(url);
            if (!r.ok) throw new Error(`Die Datei konnte nicht geladen werden (HTTP ${r.status}).`);
            const bytes = new Uint8Array(await r.arrayBuffer());
            await this.handleOpenedBytes(bytes, url.split("/").pop() ?? url, "project");
        } catch (e: any) {
            alert(e?.message ?? String(e));
            if (!this.project) await this.setProject(newProject());
        } finally {
            this.hideWait();
        }
    }

    pickFile(purpose: "project" | "database") {
        const input = document.createElement("input");
        input.type = "file";
        input.style.display = "none";
        document.body.appendChild(input);
        input.onchange = async () => {
            const file = input.files?.[0];
            input.remove();
            if (!file) return;
            this.showWait("Lese „" + file.name + "“ …");
            try {
                const bytes = new Uint8Array(await file.arrayBuffer());
                await this.handleOpenedBytes(bytes, file.name, purpose);
            } catch (e: any) {
                alert(e?.message ?? String(e));
                await this.db.open(this.project.database);
                this.renderSchema();
            } finally {
                this.hideWait();
            }
        };
        input.click();
    }

    async handleOpenedBytes(bytes: Uint8Array, fileName: string, purpose: "project" | "database") {
        const opened = await openFile(bytes, fileName, this.db, msg => this.showWait(msg));
        if (opened.kind == "project") {
            if (this.project) await this.saveLocal();
            // gleiches Projekt schon auf dem Gerät? -> neue Kopie, damit nichts überschrieben wird
            await this.setProject(opened.project);
            this.toast(`Projekt „${opened.project.name}“ geöffnet.`);
        } else if (purpose == "project") {
            // Datenbankdatei als neues Projekt öffnen
            if (this.project) await this.saveLocal();
            const p = newProject(fileName.replace(/\.[^.]*$/, ""));
            p.database = opened.data; p.template = opened.data.slice(); p.templateName = fileName;
            await this.setProject(p);
        } else {
            await this.useDatabase(opened.data, fileName, opened.errors);
        }
    }

    showHelp() {
        this.dialog("Hilfe", `
            <p><b>Alles bleibt auf deinem iPad.</b> Datenbank und Skripte werden automatisch im Browser gesichert.
            Am Ende der Stunde lädst du dein Projekt mit <b>⬇</b> herunter (Dateien → Downloads) und öffnest es nächstes Mal wieder über <b>☰ Menü → Projekt aus Datei öffnen</b>.</p>
            <h3>Ausführen</h3>
            <p><b>▶ Ausführen</b> führt die Anweisung aus, in der der Cursor steht (grün markiert). Markierst du mehrere Anweisungen, werden alle ausgeführt.
            <b>Alle</b> führt das ganze Skript aus. Rot markierte Anweisungen enthalten Fehler – die Fehlermeldung steht unter dem Editor.</p>
            <h3>Eingabehilfen</h3>
            <p>Die Leiste über dem Editor fügt Sonderzeichen und Schlüsselwörter ein. In der Schema-Ansicht fügt ein Tipp auf einen Spaltennamen diesen in den Editor ein.
            Vergessene Semikolons werden nach kurzer Zeit automatisch ergänzt.</p>
            <h3>Tastatur</h3>
            <p><kbd>⇧</kbd>+<kbd>↩</kbd> oder <kbd>⌘</kbd>+<kbd>↩</kbd> ausführen · <kbd>⌘</kbd>+<kbd>⇧</kbd>+<kbd>↩</kbd> alles ausführen · <kbd>⌘</kbd>+<kbd>Z</kbd> rückgängig · <kbd>Ctrl</kbd>+<kbd>Leertaste</kbd> Vorschläge</p>
            <h3>Lernpfade</h3>
            <p>Ein Lernpfad ist eine Anleitung mit Aufgaben, die im Projekt mitreist. <b>Quer</b> steht er rechts neben dem Editor (die Pfeile machen ihn breiter oder schmaler), <b>hochkant</b> wechselst du unten zwischen <b>Lernpfad</b>, <b>Code</b> und <b>Tabellen</b>.
            <b>☰ Menü → Demo laden</b> öffnet den Demo-Lernpfad „Der Pausenkiosk“; Lehrkräfte betten eigene Lernpfade (HTML-Seite oder ZIP mit Bildern) über <b>Lernpfad einbetten</b> ein.</p>
            <h3>Fehler gemacht?</h3>
            <p><b>↶ Daten</b> bzw. <b>☰ Menü → Letzte Datenänderung rückgängig</b> nimmt die letzte Änderung an den Daten zurück, <b>☰ Menü → Datenbank zurücksetzen</b> stellt den Ausgangszustand wieder her.</p>
            <p class="muted">QPad basiert auf der <a href="https://github.com/martin-pabst/SQL-IDE" target="_blank">SQL-IDE</a> von Martin Pabst (Compiler, Fehlermeldungen) · Editor: CodeMirror · Datenbank: SQLite (sql.js).</p>
        `);
    }

    showWelcome() {
        const demo = !!this.project?.lernpfadHtml;
        this.dialog("Willkommen bei QPad!", `
            <p>Mit QPad schreibst und testest du SQL-Anweisungen direkt auf dem iPad – ohne Anmeldung.</p>
            ${demo ? `<p>Gleich geht es los mit dem Demo-Lernpfad <b>„Der Pausenkiosk“</b>: ${this.isTabs()
                ? "Er ist unten im Reiter <b>Lernpfad</b>, deine Anweisungen schreibst du im Reiter <b>Code</b>."
                : "Er steht rechts neben dem Editor."} Mit <b>In QPad einfügen</b> übernimmst du Anweisungen direkt in den Editor.</p>` : ""}
            <ol>
                <li>Unter <b>☰ Menü → Vorlage laden</b> findest du weitere Beispieldatenbanken; eine Projektdatei deiner Lehrkraft öffnest du über <b>☰ Menü → Projekt aus Datei öffnen</b>.</li>
                <li>Schreibe SQL in den Editor und tippe auf <b>▶ Ausführen</b>.</li>
                <li>Lade dein Projekt am Ende der Stunde mit <b>⬇</b> herunter.</li>
            </ol>`, demo ? [
            { label: "Los geht’s", primary: true, action: () => { } },
        ] : [
            { label: "Vorlage wählen", primary: true, action: () => this.templateDialog() },
            { label: "Projektdatei öffnen", action: () => this.pickFile("project") },
        ]);
    }

    /** Auswahlliste mit großen Schaltflächen (Bottom-Sheet) */
    sheet(title: string, items: SheetItem[], subtitle?: string, subtitleAfter = 0) {
        const overlay = this.overlay();
        const box = document.createElement("div");
        box.className = "sheet";
        box.innerHTML = `<div class="sheet-title">${esc(title)}<button class="close" aria-label="Schließen">✕</button></div>`;
        const list = document.createElement("div");
        list.className = "sheet-list";
        items.forEach((it, i) => {
            if (subtitle && i == subtitleAfter) {
                const sub = document.createElement("div");
                sub.className = "sheet-sub";
                sub.textContent = subtitle;
                list.appendChild(sub);
            }
            const row = document.createElement("div");
            row.className = "sheet-row";
            const b = document.createElement("button");
            b.className = "sheet-item" + (it.danger ? " danger" : "");
            b.disabled = !!it.disabled;
            b.innerHTML = `<span class="ico">${it.icon ?? ""}</span><span class="txt"><span>${esc(it.label)}</span>${it.hint ? `<small>${esc(it.hint)}</small>` : ""}</span>`;
            b.onclick = () => { overlay.remove(); it.action(); };
            row.appendChild(b);
            if (it.secondary) {
                const s = document.createElement("button");
                s.className = "sheet-secondary";
                s.textContent = it.secondary.label;
                s.onclick = async () => { if (await it.secondary.action()) row.remove(); };
                row.appendChild(s);
            }
            list.appendChild(row);
        });
        box.appendChild(list);
        overlay.appendChild(box);
        (box.querySelector(".close") as HTMLElement).onclick = () => overlay.remove();
    }

    dialog(title: string, html: string, buttons: { label: string, primary?: boolean, action: () => void }[] = []) {
        const overlay = this.overlay();
        const box = document.createElement("div");
        box.className = "sheet dialog";
        box.innerHTML = `<div class="sheet-title">${esc(title)}<button class="close" aria-label="Schließen">✕</button></div><div class="dialog-body">${html}</div>`;
        if (buttons.length > 0) {
            const bar = document.createElement("div");
            bar.className = "dialog-buttons";
            for (const b of buttons) {
                const el = document.createElement("button");
                el.className = "btn" + (b.primary ? " primary" : "");
                el.textContent = b.label;
                el.onclick = () => { overlay.remove(); b.action(); };
                bar.appendChild(el);
            }
            box.appendChild(bar);
        }
        overlay.appendChild(box);
        (box.querySelector(".close") as HTMLElement).onclick = () => overlay.remove();
    }

    overlay(): HTMLElement {
        const o = document.createElement("div");
        o.className = "overlay";
        o.onclick = (e) => { if (e.target == o) o.remove(); };
        document.body.appendChild(o);
        return o;
    }

    toast(text: string, duration: number = 3800) {
        document.querySelectorAll(".toast").forEach(e => e.remove());
        const t = document.createElement("div");
        t.className = "toast";
        t.setAttribute("role", "status");
        t.textContent = text;
        document.body.appendChild(t);
        setTimeout(() => t.classList.add("hide"), duration);
        setTimeout(() => t.remove(), duration + 500);
    }

    /**
     * Kopiert den Code in die Zwischenablage – alle Skripte nacheinander (Reihenfolge wie
     * die Reiter) oder nur das geöffnete Skript (wie in JPad).
     */
    async copyCode(all: boolean) {
        const p = this.project;
        const scripts = all ? p.scripts : [p.scripts[p.activeScript]].filter(s => s != null);
        const filled = scripts.filter(s => s.text.trim() != "");
        if (filled.length == 0) { this.toast(all ? "Es gibt noch keinen Code zum Kopieren." : "Dieses Skript ist noch leer."); return; }
        const text = filled.map(s => s.text.replace(/\s+$/, "")).join("\n\n") + "\n";
        const ok = await copyToClipboard(text);
        const hint = "Füge den Code woanders wieder ein (z.B. bei einer Abgabe in einem Lernkurs).";
        if (!ok) this.toast("Kopieren hat nicht geklappt. Markiere den Code im Editor und kopiere ihn von Hand.", 5000);
        else if (all) this.toast("Code aller Skripte in die Zwischenablage kopiert. " + hint, 5000);
        else this.toast(`Code des Skripts „${scripts[0].name}“ in die Zwischenablage kopiert. ` + hint, 5000);
    }

    showWait(text: string) {
        let w = document.getElementById("wait");
        if (!w) {
            w = document.createElement("div");
            w.id = "wait";
            w.innerHTML = `<div class="wait-box"><div class="spinner"></div><div class="wait-text"></div></div>`;
            document.body.appendChild(w);
        }
        (w.querySelector(".wait-text") as HTMLElement).textContent = text;
    }
    hideWait() { document.getElementById("wait")?.remove(); }


    // ------------------------------------------------------------------ Layout (wie JPad)

    isTabs(): boolean { return this.layoutMq.matches == false; }

    private getLpMode(): LpMode {
        try { const m = localStorage.getItem("qpad.lpMode") as LpMode; if (["normal", "wide", "full", "hidden"].includes(m)) return m; } catch (e) { }
        return "wide";
    }
    private setLpMode(m: LpMode) {
        const old = this.getLpMode();
        try {
            if (m == "full" || m == "hidden") { if (old != "full" && old != "hidden") localStorage.setItem("qpad.lpBefore", old); }
            localStorage.setItem("qpad.lpMode", m);
        } catch (e) { }
        this.applyLayout();
    }
    private lpBefore(): LpMode {
        try { const m = localStorage.getItem("qpad.lpBefore") as LpMode; if (m == "normal" || m == "wide") return m; } catch (e) { }
        return "normal";
    }

    setupLayout() {
        this.layoutMq.addEventListener?.("change", () => this.applyLayout());
        document.querySelectorAll<HTMLElement>("#bottomnav [data-view]").forEach(b => {
            b.addEventListener("pointerdown", e => e.preventDefault());  // Tastatur offen lassen
            b.addEventListener("mousedown", e => e.preventDefault());
            b.onclick = () => this.setView(b.dataset.view as View);
        });
        const layoutButton = (sel: string, f: () => void) => {
            const b = $(sel);
            b.addEventListener("pointerdown", e => e.preventDefault());
            b.addEventListener("mousedown", e => e.preventDefault());
            b.onclick = f;
        };
        layoutButton("#btnLpWide", () => {
            const m = this.getLpMode();
            this.setLpMode(m == "normal" ? "wide" : m == "full" ? this.lpBefore() : "normal");
        });
        layoutButton("#btnLpFull", () => this.setLpMode("full"));
        layoutButton("#btnEditorWide", () => this.setLpMode(this.getLpMode() == "hidden" ? this.lpBefore() : "hidden"));
        // Nachrichten aus dem Lernpfad (abgeschotteter iframe)
        window.addEventListener("message", ev => this.onLernpfadMessage(ev));
        this.applyLayout();
    }

    applyLayout() {
        const app = $("#app");
        const split = this.layoutMq.matches;
        const m = this.getLpMode();
        app.dataset.layout = split ? "split" : "tabs";
        document.documentElement.dataset.layout = app.dataset.layout;
        app.dataset.lp = m;
        const setBtn = (sel: string, iconName: string, label: string, show = true) => {
            const b = $(sel);
            b.innerHTML = icon(iconName);
            b.setAttribute("aria-label", label);
            b.title = label;
            b.hidden = !show;
        };
        setBtn("#btnLpWide", m == "normal" ? "expand" : "shrink",
            m == "normal" ? "Lernpfad breiter anzeigen" : m == "wide" ? "Lernpfad schmaler anzeigen" : "Verkleinern: zurück zur Ansicht von vorher");
        setBtn("#btnLpFull", "fit", "Lernpfad auf volle Fensterbreite", m == "wide");
        setBtn("#btnEditorWide", m == "hidden" ? "lernpfad" : "expand",
            m == "hidden" ? "Lernpfad wieder einblenden" : "Editor vergrößern (Lernpfad ausblenden)");
        this.setView(this.view);
    }

    /** Ansicht im Reiter-Layout (hochkant): Lernpfad, Code oder Tabellen */
    setView(view: View) {
        const app = $("#app");
        if (view == "lernpfad" && !this.project?.lernpfadHtml) view = "code";
        this.view = view;
        app.dataset.view = view;
        document.querySelectorAll<HTMLElement>("#bottomnav [data-view]").forEach(b =>
            b.setAttribute("aria-current", String(b.dataset.view == view)));
        if (!this.editor) return;
        /*
         * Reiter-Layout mit offener Bildschirmtastatur: Beim Wechsel zu Lernpfad oder Tabellen bleibt die Tastatur
         * offen. Der (unsichtbar „geparkte“) Editor behält den Fokus und nimmt solange keine Eingaben an.
         */
        const hold = view != "code" && this.isTabs() && this.editor.view.hasFocus
            && document.documentElement.classList.contains("keyboard-open");
        if (hold) {
            app.dataset.kbhold = "true";
            this.editor.setParked(true);
        } else if (app.dataset.kbhold == "true") {
            delete app.dataset.kbhold;
            this.editor.setParked(false);
            if (view != "code") this.editor.view.contentDOM.blur();
        } else if (view != "code" && this.isTabs()) {
            this.editor.view.contentDOM.blur();
        }
        if (view == "code") this.editor.view.requestMeasure();
    }

    /** Startansicht bei Projekten mit Lernpfad: quer Tabellen zu und Lernpfad breit, hochkant der Lernpfad */
    showLernpfadLayout() {
        if (this.isTabs()) { this.setView("lernpfad"); return; }
        if (this.getLpMode() != "full") this.setLpMode("wide");
        this.toggleSidebar(false);
        this.setView("code");
    }

    // ------------------------------------------------------------------ Lernpfad

    /** Zeigt den eingebetteten Lernpfad im abgeschotteten iframe an (oder blendet die Ansicht aus). */
    showLernpfad() {
        const html = this.project?.lernpfadHtml;
        const host = $("#lernpfad");
        host.innerHTML = "";
        const app = $("#app");
        if (html) {
            app.dataset.lernpfad = "1";
            $("#lpTitle").textContent = titleOf(html) ?? "Lernpfad";
            const frame = document.createElement("iframe");
            frame.className = "lp-frame";
            frame.title = "Lernpfad";
            frame.setAttribute("sandbox", "allow-scripts allow-popups allow-popups-to-escape-sandbox allow-forms allow-modals");
            frame.setAttribute("referrerpolicy", "no-referrer");
            frame.setAttribute("allow", "clipboard-write; fullscreen");
            frame.srcdoc = withStorageShim(html, this.project.lernpfadState ?? "{}");
            host.appendChild(frame);
        } else {
            delete app.dataset.lernpfad;
            if (this.view == "lernpfad") this.setView("code");
        }
    }

    private onLernpfadMessage(ev: MessageEvent) {
        const frame = $("#lernpfad").querySelector("iframe");
        if (!frame || ev.source != frame.contentWindow || !this.project) return;
        const d = ev.data;
        if (d?.type == "qpad-lernpfad-storage") {
            // Häkchen usw. nur lokal merken; das Projekt gilt dadurch nicht als geändert
            try { this.project.lernpfadState = JSON.stringify(d.state ?? {}); } catch (e) { return; }
            clearTimeout(this.lpStateTimer);
            this.lpStateTimer = setTimeout(() => LocalStore.save(this.project).catch(() => { }), 500);
        } else if (d?.type == "qpad-insert" && typeof d.sql == "string" && d.sql.length < 20000) {
            // „In QPad einfügen“ im Lernpfad: Anweisung ans Ende des geöffneten Skripts
            if (this.isTabs()) this.setView("code");
            this.editor.appendBlock(d.sql);
            this.toast(`In „${this.project.scripts[this.project.activeScript].name}“ eingefügt. Tippe auf ▶ Ausführen.`, 3200);
        }
    }

    pickLernpfad() {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = ".html,.htm,.zip,text/html,application/zip";
        input.style.display = "none";
        document.body.appendChild(input);
        input.onchange = async () => {
            const file = input.files?.[0];
            input.remove();
            if (!file) return;
            try {
                const html = await readLernpfadFile(file);
                if (this.project.lernpfadHtml && !confirm("Dieses Projekt hat schon einen Lernpfad. Er wird durch die neue Datei ersetzt.")) return;
                this.project.lernpfadHtml = html;
                this.project.lernpfadState = "{}";
                this.touch();
                this.showLernpfad();
                this.showLernpfadLayout();
                this.toast(`Lernpfad „${file.name}“ eingebettet. Er wird mit dem Projekt als Datei gesichert.`, 4000);
                const v = vorlageOf(html);
                if (v && this.db.databaseStructure.tables.length == 0
                    && confirm(`Zu diesem Lernpfad gehört die Datenbank „${v}“. Jetzt laden?`)) {
                    await this.createProjectFromTemplate(await this.templateFor(v, location.href));
                }
            } catch (e: any) {
                alert("Lernpfad lässt sich nicht einbetten: " + (e?.message ?? e));
            }
        };
        input.click();
    }

    removeLernpfad() {
        if (!this.project.lernpfadHtml) return;
        if (!confirm("Der Lernpfad wird aus diesem Projekt entfernt. Skripte und Datenbank bleiben erhalten.")) return;
        this.project.lernpfadHtml = null;
        this.project.lernpfadState = undefined;
        this.touch();
        this.showLernpfad();
        this.toast("Lernpfad entfernt.");
    }

    /** Menü „Demo laden“: jedes Mal ein neues Projekt mit frischer Kopie des Demo-Lernpfads */
    async loadDemo() {
        await this.saveLocal();
        await this.openFromLink({ lernpfad: DEMO_LERNPFAD, fresh: true });
    }

    /** Vorlage aus dem <meta name="qpad-vorlage">: Dateiname aus vorlagen/ oder Adresse relativ zum Lernpfad */
    private async templateFor(v: string, base: string): Promise<Template & { url?: string }> {
        await this.ensureTemplates();
        const t = this.templates.find(t => t.file.toLowerCase() == v.toLowerCase());
        if (t) return t;
        const url = new URL(v, base).href;
        return { name: nameFromUrl(url), file: v, url };
    }

    /**
     * Link mit Lernpfad: qpad…/?lernpfad=<Adresse> (HTML, ZIP oder Projektdatei), optional &projekt=<Projektdatei>
     * oder &vorlage=<Datenbank>. Beim ersten Aufruf entsteht ein neues Projekt; derselbe Link öffnet später dieses
     * Projekt mit dem Stand des Schülers (außer mit &neu). Danach verschwinden die Parameter aus der Adresszeile.
     */
    async openFromLink(link: { lernpfad: string, projekt?: string | null, vorlage?: string | null, fresh?: boolean }, quiet = false): Promise<boolean> {
        try { history.replaceState(null, "", location.pathname + location.hash); } catch (e) { }
        const abs = (u?: string | null) => u ? new URL(u.trim(), location.href).href : null;
        const lernpfad = abs(link.lernpfad)!, projekt = abs(link.projekt);
        const source = [projekt, lernpfad, link.vorlage ? "vorlage:" + link.vorlage : null].filter(s => s).join(" + ");
        try {
            if (!link.fresh) {
                const existing = (await LocalStore.list()).find(p => p.source == source);
                if (existing) {
                    if (this.project) await this.saveLocal();
                    await this.setProject(existing);
                    if (!quiet) this.toast(`„${existing.name}“ geöffnet – mit deinem bisherigen Stand.`);
                    return true;
                }
            }
            this.showWait("Lernpfad wird geladen …");
            const loaded = await loadLernpfadUrl(lernpfad);
            let p: Project;
            let html: string | null = null;
            if (loaded.kind == "project") {
                const opened = await openFile(loaded.bytes, loaded.name + ".sqlprojekt.json", this.db, msg => this.showWait(msg));
                if (opened.kind != "project") throw new Error("Die Projektdatei des Lernpfads ist nicht lesbar.");
                p = opened.project;
            } else {
                html = loaded.html;
                if (projekt) {
                    const r = await fetch(projekt);
                    if (!r.ok) throw new Error(`„${projekt}“ wurde nicht gefunden (Fehler ${r.status}).`);
                    const opened = await openFile(new Uint8Array(await r.arrayBuffer()), nameFromUrl(projekt) + ".sqlprojekt.json", this.db, msg => this.showWait(msg));
                    if (opened.kind != "project") throw new Error(`„${projekt}“ ist keine Projektdatei.`);
                    p = opened.project;
                } else {
                    p = newProject(loaded.name);
                }
                p.lernpfadHtml = html;
            }
            if (!link.fresh) p.source = source;
            if (this.project) await this.saveLocal();
            await this.setProject(p);
            // Datenbank: &vorlage=… oder die Vorlage, die der Lernpfad selbst nennt (nur wenn noch keine Datenbank da ist)
            const v = link.vorlage ?? (html && !p.database ? vorlageOf(html) : undefined);
            if (v) await this.createProjectFromTemplate(await this.templateFor(v, link.vorlage ? location.href : lernpfad));
            this.hideWait();
            if (!quiet) this.toast(`„${p.name}“ geöffnet.` + (loaded.kind == "html" && loaded.note ? " " + loaded.note : ""), 4000);
            return true;
        } catch (e: any) {
            this.hideWait();
            alert("Lernpfad lässt sich nicht öffnen: " + (e?.message ?? e));
            return false;
        }
    }

    /**
     * iPad im Querformat und die Bildschirmtastatur geht auf (also keine echte Tastatur): einmal pro Sitzung
     * empfehlen, QPad hochkant zu benutzen. „Nicht mehr zeigen“ gilt 4 Wochen (wie JPad).
     */
    private maybeRotateHint() {
        const html = document.documentElement;
        if (!html.classList.contains("touch") || html.classList.contains("phone")) return;
        try {
            if (sessionStorage.getItem("qpad.rotateHintShown")) return;
            if (Date.now() < parseInt(localStorage.getItem("qpad.rotateHintOff") || "0")) return;
        } catch (e) { }
        setTimeout(() => {
            if (window.innerWidth <= window.innerHeight || !html.classList.contains("keyboard-open")) return;
            if (document.querySelector(".overlay")) return;
            try { sessionStorage.setItem("qpad.rotateHintShown", "1"); } catch (e) { }
            const overlay = this.overlay();
            overlay.classList.add("is-rotate-layer");
            const box = document.createElement("div");
            box.className = "sheet is-rotate";
            box.setAttribute("role", "dialog");
            box.innerHTML = `
                <div class="rotate-row">
                    <div class="rotate-anim" aria-hidden="true">
                        <svg viewBox="30 18 160 150">
                            <g class="rot-arrows" fill="none" stroke="currentColor" stroke-width="6" stroke-linecap="round" stroke-linejoin="round">
                                <path d="M169.8 65.1 A 66 66 0 0 0 50.2 65.1"/><path d="M60.8 57.7 L50.2 65.1 L49.1 52.2"/>
                                <path d="M50.2 120.9 A 66 66 0 0 0 169.8 120.9"/><path d="M159.2 128.3 L169.8 120.9 L170.9 133.8"/>
                            </g>
                            <g class="rot-device">
                                <rect x="66" y="63" width="88" height="60" rx="8" class="rot-body"/>
                                <rect x="73" y="69" width="74" height="48" rx="3" class="rot-screen"/>
                                <g class="rot-kb"><rect x="76" y="97" width="68" height="17" rx="2"/><path d="M80 102h60M80 106.5h60M80 111h60"/></g>
                            </g>
                        </svg>
                    </div>
                    <div class="rotate-text">
                        <h2>Dreh dein iPad hochkant</h2>
                        <p>Ohne echte Tastatur verdeckt die Bildschirmtastatur im Querformat fast den ganzen Editor.
                        Benutze QPad <b>hochkant</b>, wenn du ohne Tastatur arbeitest, und <b>quer</b> mit einer echten Tastatur.</p>
                    </div>
                </div>
                <div class="rotate-foot">
                    <label><input type="checkbox" data-dontshow><span>Diesen Hinweis nicht mehr zeigen</span></label>
                    <button type="button" class="btn primary" data-ok>Verstanden</button>
                </div>`;
            overlay.appendChild(box);
            (box.querySelector("[data-ok]") as HTMLElement).onclick = () => {
                if ((box.querySelector("[data-dontshow]") as HTMLInputElement).checked) {
                    try { localStorage.setItem("qpad.rotateHintOff", String(Date.now() + 28 * 24 * 3600 * 1000)); } catch (e) { }
                }
                overlay.remove();
            };
        }, 600);
    }

    // ------------------------------------------------------------------ Oberfläche

    buildSymbolBar() {
        const bar = $("#symbolbar");
        const symbols = ["*", ".", ",", "=", "'|'", "<", ">", "<>", "(", ")", "%", "_"];
        // Glühbirne: bleibt links stehen, erklärt die Hilfe per langem Drücken
        const bulb = document.createElement("button");
        bulb.className = "bulb";
        bulb.setAttribute("aria-label", "Tipp zur Funktionsleiste");
        bulb.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18h6"/><path d="M10 21h4"/><path d="M12 3a6 6 0 0 0-3.6 10.8c.6.5 1 1.2 1.1 2V16h5v-.2c.1-.8.5-1.5 1.1-2A6 6 0 0 0 12 3z"/></svg>`;
        bulb.addEventListener("pointerdown", e => e.preventDefault());
        bulb.addEventListener("mousedown", e => e.preventDefault());
        bulb.onclick = () => {
            if (this.symHelpEl?.classList.contains("symhelp-info")) { this.hideSymbolHelp(); return; }
            this.hideSymbolHelp();
            const pop = document.createElement("div");
            pop.className = "symhelp symhelp-info";
            pop.setAttribute("role", "dialog");
            pop.innerHTML = `
                <div class="symhelp-info-row">
                    <span class="symhelp-info-icon">${bulb.innerHTML}</span>
                    <p>Weißt Du nicht, was ein Button in der Funktionsleiste bewirkt? Lege einfach eine halbe Sekunde lang Deinen Finger auf die Funktion, um Hilfe zu bekommen.</p>
                    <button class="symhelp-close iconbtn small" aria-label="Hinweis schließen">✕</button>
                </div>`;
            this.openPopover(pop, bulb);
        };
        bar.appendChild(bulb);
        const words = ["select", "from", "where", "and", "or", "not", "join", "on", "as", "group by", "having", "order by", "desc",
            "count(|)", "sum(|)", "avg(|)", "min(|)", "max(|)", "length(|)", "distinct", "like", "in", "between", "is null", "limit",
            "insert into", "values", "update", "set", "delete from", "create table", "primary key", "references", "integer", "varchar(|)"];
        const add = (label: string, cls: string) => {
            const b = document.createElement("button");
            b.className = cls;
            b.textContent = label.replace("|", "");
            const hasHelp = helpFor(label) != null;
            if (hasHelp) b.title = "Antippen: einfügen · Lange drücken: Hilfe";
            // Lange drücken (0,5 s) öffnet die Kurzhilfe, kurzes Tippen fügt ein
            let timer: any = null, longPressed = false, sx = 0, sy = 0;
            const cancel = () => { clearTimeout(timer); timer = null; b.classList.remove("holding"); };
            // Fokus im Editor behalten (sonst klappt die Bildschirmtastatur zu)
            b.addEventListener("pointerdown", e => {
                e.preventDefault();
                longPressed = false;
                if (!hasHelp || e.button > 0) return;
                sx = e.clientX; sy = e.clientY;
                cancel();
                b.classList.add("holding");
                timer = setTimeout(() => {
                    timer = null; longPressed = true; b.classList.remove("holding");
                    this.showSymbolHelp(label, b);
                }, 500);
            });
            b.addEventListener("pointermove", e => { if (timer && Math.hypot(e.clientX - sx, e.clientY - sy) > 12) cancel(); });
            for (const ev of ["pointerup", "pointercancel", "pointerleave"]) b.addEventListener(ev, cancel);
            b.addEventListener("mousedown", e => e.preventDefault());
            b.addEventListener("contextmenu", e => e.preventDefault());
            b.onclick = () => {
                if (longPressed) { longPressed = false; return; }
                this.editor.insert(label);
            };
            bar.appendChild(b);
        };
        symbols.forEach(s => add(s, "sym"));
        words.forEach(w => add(w, "kw"));
        bar.addEventListener("scroll", () => this.hideSymbolHelp(), { passive: true });
    }

    private symHelpEl: HTMLElement | null = null;

    /** Kurzhilfe zu einem Button der Symbolleiste: Erklärung + einfaches und anspruchsvolleres Beispiel */
    showSymbolHelp(label: string, anchor: HTMLElement) {
        const found = helpFor(label);
        if (!found) return;
        const { key, help } = found;
        this.hideSymbolHelp();
        const pop = document.createElement("div");
        pop.className = "symhelp";
        pop.setAttribute("role", "dialog");
        pop.setAttribute("aria-label", `Hilfe zu ${key}`);
        const title = help.kind == "Funktion" ? `${key}(…)` : key == "''" ? "' … '" : key;
        const example = (caption: string, sql: string, i: number) => `
            <div class="symhelp-ex">
                <div class="symhelp-ex-head"><span>${caption}</span>
                    <button class="symhelp-insert" data-ex="${i}" title="Beispiel in den Editor übernehmen">Einfügen</button></div>
                <pre class="symhelp-code">${highlightToHtml(sql)}</pre>
            </div>`;
        pop.innerHTML = `
            <div class="symhelp-head">
                <code class="symhelp-title">${esc(title)}</code>
                <span class="symhelp-kind">${help.kind}</span>
                <span class="spacer"></span>
                <button class="symhelp-close iconbtn small" aria-label="Hilfe schließen">✕</button>
            </div>
            <p class="symhelp-text">${esc(help.text)}</p>
            ${example("Einfaches Beispiel", help.simple, 0)}
            ${example("Etwas anspruchsvoller", help.advanced, 1)}
            ${help.note ? `<p class="symhelp-note">${esc(help.note)}</p>` : ""}
            <p class="symhelp-foot">Die Beispiele passen zur Vorlage „Terra (Geographie)“.</p>`;
        // Buttons im Popup sollen den Editor-Fokus nicht stehlen
        pop.querySelectorAll("button").forEach(btn => {
            btn.addEventListener("pointerdown", e => e.preventDefault());
            btn.addEventListener("mousedown", e => e.preventDefault());
        });
        (pop.querySelector(".symhelp-close") as HTMLElement).onclick = () => this.hideSymbolHelp();
        pop.querySelectorAll<HTMLElement>(".symhelp-insert").forEach(btn => btn.onclick = () => {
            this.editor.insertBlock(btn.dataset.ex == "0" ? help.simple : help.advanced);
            this.hideSymbolHelp();
            this.toast("Beispiel eingefügt – mit ▶ Ausführen kannst Du es testen.");
        });
        this.openPopover(pop, anchor);
    }

    /** Popup unter (oder notfalls über) einem Button der Symbolleiste anzeigen */
    private openPopover(pop: HTMLElement, anchor: HTMLElement) {
        pop.querySelectorAll("button").forEach(btn => {
            btn.addEventListener("pointerdown", e => e.preventDefault());
            btn.addEventListener("mousedown", e => e.preventDefault());
        });
        const close = pop.querySelector(".symhelp-close") as HTMLElement | null;
        if (close) close.onclick = () => this.hideSymbolHelp();
        document.body.appendChild(pop);
        this.symHelpEl = pop;

        // unter (oder notfalls über) dem Button platzieren
        const r = anchor.getBoundingClientRect();
        const vw = document.documentElement.clientWidth, vh = window.visualViewport?.height ?? window.innerHeight;
        const w = pop.offsetWidth, h = pop.offsetHeight;
        const left = Math.max(8, Math.min(vw - w - 8, r.left + r.width / 2 - w / 2));
        let top = r.bottom + 8;
        if (top + h > vh - 8 && r.top - 8 - h >= 8) top = r.top - 8 - h;
        pop.style.left = left + "px";
        pop.style.top = Math.max(8, top) + "px";
        pop.style.setProperty("--arrow-x", Math.max(16, Math.min(w - 16, r.left + r.width / 2 - left)) + "px");
        pop.classList.toggle("above", top < r.top);

        const outside = (e: Event) => {
            const t = e.target as Node;
            // Tippen auf die Glühbirne bei offenem Hinweis: deren Klick schließt selbst
            if (pop.contains(t) || (pop.classList.contains("symhelp-info") && anchor.contains(t))) return;
            this.hideSymbolHelp();
        };
        const key_ = (e: KeyboardEvent) => { if (e.key == "Escape") this.hideSymbolHelp(); };
        setTimeout(() => {
            document.addEventListener("pointerdown", outside, true);
            document.addEventListener("keydown", key_, true);
        }, 0);
        (pop as any)._cleanup = () => {
            document.removeEventListener("pointerdown", outside, true);
            document.removeEventListener("keydown", key_, true);
        };
    }

    hideSymbolHelp() {
        const pop = this.symHelpEl;
        if (!pop) return;
        (pop as any)._cleanup?.();
        pop.remove();
        this.symHelpEl = null;
    }

    bindUi() {
        $("#btnProject").onclick = () => this.openDrawer();
        $("#projectName").onclick = () => this.renameProject();
        $("#drawerClose").onclick = () => this.closeDrawer();
        $("#drawerBackdrop").onclick = () => this.closeDrawer();
        const menu = (id: string, f: () => any) => $(id).onclick = () => { this.closeDrawer(); f(); };
        menu("#drawerNew", () => this.newProjectDialog());
        menu("#drawerOpen", () => this.pickFile("project"));
        menu("#drawerSave", () => this.downloadProject());
        menu("#drawerShare", () => this.shareProject());
        menu("#drawerRename", () => this.renameProject());
        menu("#drawerTemplate", () => this.templateDialog());
        menu("#drawerImport", () => this.pickFile("database"));
        menu("#drawerExportDb", async () => {
            const data = await this.db.export();
            this.downloadBlob(new Blob([data as BlobPart], { type: "application/x-sqlite3" }), safeFileName(this.project.name) + ".sqlite");
        });
        menu("#drawerDbUndo", () => this.undoDatabase());
        menu("#drawerReset", () => this.resetDatabase());
        menu("#drawerHelp", () => this.showHelp());
        menu("#drawerDemo", () => this.loadDemo());
        menu("#drawerLpAdd", () => this.pickLernpfad());
        menu("#drawerLpRemove", () => this.removeLernpfad());
        document.querySelectorAll<HTMLElement>("[data-theme-choice]").forEach(b => b.onclick = () => this.setThemeChoice(b.dataset.themeChoice));
        this.buildSkinPicker();
        $("#fontSmaller").onclick = () => this.setFontSize(this.getFontSize() - 1);
        $("#fontBigger").onclick = () => this.setFontSize(this.getFontSize() + 1);
        this.setFontSize(this.getFontSize());
        document.addEventListener("keydown", e => { if (e.key == "Escape") this.closeDrawer(); });
        $("#btnDownload").onclick = () => this.downloadProject();
        $("#btnCopyAll").onclick = () => this.copyCode(true);
        $("#btnCopyScript").onclick = () => this.copyCode(false);
        $("#btnSchema").onclick = () => this.isTabs() ? this.setView(this.view == "tabellen" ? "code" : "tabellen") : this.toggleSidebar();
        $("#btnSidebarClose").onclick = () => this.toggleSidebar(false);
        $("#sidebarBackdrop").onclick = () => this.toggleSidebar(false);
        $("#btnRun").onclick = () => this.run(false);
        $("#btnRunAll").onclick = () => this.run(true);
        $("#btnDbUndo").onclick = () => this.undoDatabase();
        $("#btnUndo").onclick = () => this.editor.undo();
        $("#btnRedo").onclick = () => this.editor.redo();
        $("#status").onclick = () => this.editor.gotoNextError();
        ["#btnRun", "#btnRunAll", "#btnUndo", "#btnRedo", "#btnCopyAll", "#btnCopyScript"].forEach(s => $(s).addEventListener("mousedown", e => e.preventDefault()));

        this.setupSplitter();
        this.toggleSidebar(this.layoutMq.matches);
        this.setupLayout();

        // Sicherung beim Verlassen/Wechseln der App
        document.addEventListener("visibilitychange", () => { if (document.visibilityState == "hidden") this.saveLocal(); });
        window.addEventListener("pagehide", () => this.saveLocal());
    }

    setupSplitter() {
        const splitter = $("#splitter");
        const center = $("#center");
        let ratio = 0.5;
        try { ratio = parseFloat(localStorage.getItem("sql-ide-pad.split") ?? "0.5") || 0.5; } catch (e) { }
        const pane = center.querySelector(".editor-pane") as HTMLElement, results = $("#results");
        const apply = () => { pane.style.flex = `${ratio} 1 0`; results.style.flex = `${1 - ratio} 1 0`; };
        apply();
        splitter.addEventListener("pointerdown", (e) => {
            splitter.setPointerCapture(e.pointerId);
            const rect = center.getBoundingClientRect();
            const move = (ev: PointerEvent) => {
                ratio = Math.min(0.85, Math.max(0.15, (ev.clientY - rect.top) / rect.height));
                apply();
            };
            const up = () => {
                splitter.removeEventListener("pointermove", move);
                splitter.removeEventListener("pointerup", up);
                try { localStorage.setItem("sql-ide-pad.split", String(ratio)); } catch (e) { }
            };
            splitter.addEventListener("pointermove", move);
            splitter.addEventListener("pointerup", up);
        });
    }

    /** Höhe an die sichtbare Fläche anpassen (Bildschirmtastatur auf dem iPad) */
    setupViewport() {
        const vv = window.visualViewport;
        const root = document.documentElement;
        const touch = matchMedia("(pointer: coarse)").matches || navigator.maxTouchPoints > 1;
        root.classList.toggle("touch", touch);
        root.classList.toggle("phone", touch && Math.min(screen.width, screen.height) < 600);
        let kbOpen = false;
        const set = () => {
            const h = vv ? vv.height : window.innerHeight;
            root.style.setProperty("--app-height", h + "px");
            if (vv) window.scrollTo(0, 0);
            // Bildschirmtastatur offen? (die sichtbare Fläche ist deutlich kleiner als das Fenster)
            const open = touch && !!vv && window.innerHeight - vv.height > 120;
            if (open != kbOpen) {
                kbOpen = open;
                root.classList.toggle("keyboard-open", open);
                if (open) this.maybeRotateHint();
            }
        };
        set();
        vv?.addEventListener("resize", set);
        window.addEventListener("resize", set);
    }
}

type SheetItem = {
    label: string, icon?: string, hint?: string, danger?: boolean, disabled?: boolean,
    action: () => any,
    secondary?: { label: string, action: () => Promise<boolean> }
};

/** Hell/Dunkel/System – wie in JPad über data-effective am <html>-Element; dazu das Theme (data-skin) */
function applyTheme() {
    let choice = "auto", skin = "default";
    try { choice = localStorage.getItem("qpad.theme") || "auto"; skin = localStorage.getItem("qpad.skin") || "default"; } catch (e) { }
    const root = document.documentElement;
    const dark = choice == "dark" || (choice == "auto" && matchMedia("(prefers-color-scheme: dark)").matches);
    root.dataset.effective = dark ? "dark" : "light";
    if (skin == "default") delete root.dataset.skin;
    else { root.dataset.skin = skin; loadSkinFonts(); }
    const bar = getComputedStyle(root).getPropertyValue("--bg").trim();
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", bar || (dark ? "#16181d" : "#f4f5f7"));
}

/** Schriften der Themes (nur online; ohne Netz greifen die Ersatzschriften) */
function loadSkinFonts() {
    if (document.getElementById("qp-skin-fonts")) return;
    const link = document.createElement("link");
    link.id = "qp-skin-fonts";
    link.rel = "stylesheet";
    link.href = "https://fonts.googleapis.com/css2?family=Chakra+Petch:wght@400;500;600&family=Share+Tech+Mono"
        + "&family=Atkinson+Hyperlegible:wght@400;700&family=JetBrains+Mono:wght@400;600&family=Pixelify+Sans:wght@500;700&display=swap";
    document.head.appendChild(link);
}
applyTheme();
matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", applyTheme);

function isModifying(st: SQLStatement): boolean {
    return st.ast != null && st.ast.type != TokenType.keywordSelect && st.ast.type != TokenType.omittedeStatement;
}

function isDataOnly(st: SQLStatement): boolean {
    return [TokenType.keywordInsert, TokenType.keywordUpdate, TokenType.keywordDelete].includes(st.ast?.type);
}

function oneLine(sql: string): string {
    return sql.replace(/\s*\n\s*/g, " ").replace(/\s\s+/g, " ").trim();
}

new App().start().catch(e => {
    console.error(e);
    document.body.insertAdjacentHTML("beforeend", `<div class="fatal">Die App konnte nicht gestartet werden: ${esc(e?.message ?? e)}</div>`);
});

if ("serviceWorker" in navigator && location.protocol == "https:") {
    navigator.serviceWorker.register("sw.js").catch(() => { });
}

/** Zwischenablage mit Rückfall für ältere Browser (wie in JPad). */
async function copyToClipboard(text: string): Promise<boolean> {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch (e) { /* weiter mit dem Rückfall */ }
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "-1000px";
    ta.style.fontSize = "16px";
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    let ok = false;
    try { ok = document.execCommand("copy"); } catch (e) { }
    ta.remove();
    return ok;
}
