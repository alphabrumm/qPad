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
import { translateSqliteError } from "./translate.js";
import { icon } from "./icons.js";

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

        // Projekt aus URL (für Lehrkräfte: ?projekt=datei.sqlprojekt.json oder ?vorlage=datenbank.sqLite)
        const params = new URLSearchParams(location.search);
        const urlProject = params.get("projekt"), urlTemplate = params.get("vorlage");
        if (urlProject || urlTemplate) history.replaceState(null, "", location.pathname);

        let project: Project | undefined;
        try {
            const id = lastProjectId();
            if (id) project = await LocalStore.load(id);
            if (!project) project = (await LocalStore.list())[0];
        } catch (e) {
            console.warn("Lokaler Speicher nicht verfügbar", e);
        }

        if (urlProject) {
            await this.openFromUrl(urlProject);
        } else if (urlTemplate) {
            await this.setProject(project ?? newProject());
            await this.createProjectFromTemplate({ name: urlTemplate.replace(/\.[^.]*$/, ""), file: urlTemplate });
        } else if (project) {
            await this.setProject(project);
        } else {
            await this.setProject(newProject("Mein erstes Projekt"));
            this.showWelcome();
        }
        $("#loading").remove();
    }

    // ------------------------------------------------------------------ Projekt

    async setProject(p: Project) {
        this.project = p;
        this.dbUndo = [];
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
        $("#btnDbUndo").classList.toggle("disabled", this.dbUndo.length == 0);

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

    async undoDatabase() {
        const snap = this.dbUndo.pop();
        if (!snap) { this.toast("Es gibt keine Datenbankänderung, die rückgängig gemacht werden kann."); return; }
        await this.db.open(snap);
        await this.flushDatabase();
        this.renderSchema();
        this.editor.compileNow();
        this.touch();
        $("#btnDbUndo").classList.toggle("disabled", this.dbUndo.length == 0);
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
        $("#btnDbUndo").classList.remove("disabled");
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
        if (window.innerWidth < 900) this.toggleSidebar(false);
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
    renderSettings() {
        const c = this.getThemeChoice();
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

    async createProjectFromTemplate(t: Template) {
        this.showWait(`Lade „${t.name}“ …`);
        try {
            const r = await fetch("vorlagen/" + t.file);
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
        this.dbUndo.push(await this.db.export());
        await this.db.open(data);
        this.project.template = data.slice();
        this.project.templateName = name;
        await this.flushDatabase();
        this.renderSchema();
        this.editor.compileNow();
        this.touch();
        $("#btnDbUndo").classList.remove("disabled");
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
            <h3>Fehler gemacht?</h3>
            <p><b>↶ Daten</b> bzw. <b>☰ Menü → Letzte Datenänderung rückgängig</b> nimmt die letzte Änderung an den Daten zurück, <b>☰ Menü → Datenbank zurücksetzen</b> stellt den Ausgangszustand wieder her.</p>
            <p class="muted">QPad basiert auf der <a href="https://github.com/martin-pabst/SQL-IDE" target="_blank">SQL-IDE</a> von Martin Pabst (Compiler, Fehlermeldungen) · Editor: CodeMirror · Datenbank: SQLite (sql.js).</p>
        `);
    }

    showWelcome() {
        this.dialog("Willkommen bei QPad!", `
            <p>Mit QPad schreibst und testest du SQL-Anweisungen direkt auf dem iPad – ohne Anmeldung.</p>
            <ol>
                <li>Wähle unter <b>☰ Menü → Vorlage laden</b> eine Beispieldatenbank oder öffne eine Projektdatei deiner Lehrkraft.</li>
                <li>Schreibe SQL in den Editor und tippe auf <b>▶ Ausführen</b>.</li>
                <li>Lade dein Projekt am Ende der Stunde mit <b>⬇</b> herunter.</li>
            </ol>`, [
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

    toast(text: string) {
        const t = document.createElement("div");
        t.className = "toast";
        t.textContent = text;
        document.body.appendChild(t);
        setTimeout(() => t.classList.add("hide"), 3800);
        setTimeout(() => t.remove(), 4300);
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

    // ------------------------------------------------------------------ Oberfläche

    buildSymbolBar() {
        const bar = $("#symbolbar");
        const symbols = [";", ",", "(", ")", "*", "=", "<", ">", "<>", "'|'", ".", "_", "%"];
        const words = ["select", "from", "where", "and", "or", "not", "join", "on", "as", "group by", "having", "order by", "desc",
            "count(|)", "sum(|)", "avg(|)", "min(|)", "max(|)", "distinct", "like", "in", "between", "is null", "limit",
            "insert into", "values", "update", "set", "delete from", "create table", "primary key", "references", "integer", "varchar(|)"];
        const add = (label: string, cls: string) => {
            const b = document.createElement("button");
            b.className = cls;
            b.textContent = label.replace("|", "");
            // Fokus im Editor behalten (sonst klappt die Bildschirmtastatur zu)
            b.addEventListener("pointerdown", e => e.preventDefault());
            b.addEventListener("mousedown", e => e.preventDefault());
            b.onclick = () => this.editor.insert(label);
            bar.appendChild(b);
        };
        symbols.forEach(s => add(s, "sym"));
        words.forEach(w => add(w, "kw"));
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
        document.querySelectorAll<HTMLElement>("[data-theme-choice]").forEach(b => b.onclick = () => this.setThemeChoice(b.dataset.themeChoice));
        $("#fontSmaller").onclick = () => this.setFontSize(this.getFontSize() - 1);
        $("#fontBigger").onclick = () => this.setFontSize(this.getFontSize() + 1);
        this.setFontSize(this.getFontSize());
        document.addEventListener("keydown", e => { if (e.key == "Escape") this.closeDrawer(); });
        $("#btnDownload").onclick = () => this.downloadProject();
        $("#btnSchema").onclick = () => this.toggleSidebar();
        $("#btnSidebarClose").onclick = () => this.toggleSidebar(false);
        $("#sidebarBackdrop").onclick = () => this.toggleSidebar(false);
        $("#btnRun").onclick = () => this.run(false);
        $("#btnRunAll").onclick = () => this.run(true);
        $("#btnDbUndo").onclick = () => this.undoDatabase();
        $("#btnUndo").onclick = () => this.editor.undo();
        $("#btnRedo").onclick = () => this.editor.redo();
        $("#status").onclick = () => this.editor.gotoNextError();
        ["#btnRun", "#btnRunAll", "#btnUndo", "#btnRedo"].forEach(s => $(s).addEventListener("mousedown", e => e.preventDefault()));

        this.setupSplitter();
        if (window.innerWidth >= 900) this.toggleSidebar(true); else this.toggleSidebar(false);

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
        const set = () => {
            const h = vv ? vv.height : window.innerHeight;
            document.documentElement.style.setProperty("--app-height", h + "px");
            if (vv) window.scrollTo(0, 0);
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

/** Hell/Dunkel/System – wie in JPad über data-effective am <html>-Element */
function applyTheme() {
    let choice = "auto";
    try { choice = localStorage.getItem("qpad.theme") || "auto"; } catch (e) { }
    const dark = choice == "dark" || (choice == "auto" && matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.dataset.effective = dark ? "dark" : "light";
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", dark ? "#16181d" : "#f4f5f7");
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
