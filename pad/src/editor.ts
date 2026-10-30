/**
 * Touch-taugliches Editorfeld auf Basis von CodeMirror 6 (ersetzt den Monaco-Editor).
 * - native iOS-Textauswahl (keine eigene Selektionszeichnung)
 * - keine Autokorrektur/Großschreibung
 * - Fehler des SQL-IDE-Compilers als Unterringelung + Statuszeile
 * - Hervorhebung der Anweisung, die beim Tippen auf "Ausführen" ausgeführt wird
 */
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap, startCompletion } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab, redo, undo } from "@codemirror/commands";
import { bracketMatching, indentOnInput } from "@codemirror/language";
import { Diagnostic, lintGutter, setDiagnostics } from "@codemirror/lint";
import { Compartment, EditorSelection, EditorState, Extension, RangeSetBuilder, StateEffect, StateField } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, highlightActiveLineGutter, keymap, lineNumbers, ViewUpdate } from "@codemirror/view";
import type { SQLStatement } from "../../src/client/compiler/parser/Parser.js";
import { compile, SemicolonAngel } from "./compile.js";
import { makeCompletionSource } from "./completion.js";
import type { PadDatabase } from "./db.js";
import type { PadModule } from "./module.js";
import { sqlLanguage } from "./sqlLanguage.js";

const setStatementMarks = StateEffect.define<DecorationSet>();
const statementMarks = StateField.define<DecorationSet>({
    create: () => Decoration.none,
    update(value, tr) {
        for (const e of tr.effects) if (e.is(setStatementMarks)) return e.value;
        return value.map(tr.changes);
    },
    provide: f => EditorView.decorations.from(f)
});

/**
 * Nach einem Stern (select *, a.*) folgt immer ein Leerzeichen – außer in count(*): direkt nach „(“
 * bzw. wenn schon ein Leerzeichen oder „)“ folgt.
 */
function starInsert(doc: { sliceString(from: number, to: number): string }, from: number, to: number): string {
    const before = doc.sliceString(Math.max(0, from - 1), from);
    const after = doc.sliceString(to, to + 1);
    if (before == "(" || /^[\s)]$/.test(after)) return "*";
    return "* ";
}

export type EditorCallbacks = {
    onRun: (all: boolean) => void;
    onChange: (text: string) => void;
    onStatus: (html: string, level: "ok" | "error" | "warning" | "info") => void;
    onCompiled: (module: PadModule) => void;
};

export class SqlEditor {

    view: EditorView;
    module: PadModule | null = null;
    angel = new SemicolonAngel();
    private compileTimer: any = null;
    private silent = false;
    private extensions: Extension[] = [];
    /** „geparkt“ (Reiter-Layout mit offener Tastatur, andere Ansicht sichtbar): nimmt keine Eingaben an */
    private parking = new Compartment();
    /** Position direkt hinter einem automatisch ergänzten „* “: ein gleich danach getipptes Leerzeichen wird verschluckt */
    private starSpaceAt = -1;

    constructor(parent: HTMLElement, private db: PadDatabase, private cb: EditorCallbacks) {

        const runKeys = [
            { key: "Mod-Enter", run: () => { this.cb.onRun(false); return true; } },
            { key: "Shift-Enter", run: () => { this.cb.onRun(false); return true; } },
            { key: "Mod-Shift-Enter", run: () => { this.cb.onRun(true); return true; } },
            { key: "Ctrl-Space", run: startCompletion },
        ];

        const extensions: Extension[] = [
            lineNumbers(),
            highlightActiveLineGutter(),
            history(),
            indentOnInput(),
            bracketMatching(),
            closeBrackets(),
            sqlLanguage,
            autocompletion({ override: [makeCompletionSource(() => this.upToDateModule(), () => this.db.databaseStructure)], icons: false, activateOnTypingDelay: 150 }),
            lintGutter(),
            statementMarks,
            keymap.of([...runKeys, ...closeBracketsKeymap, ...completionKeymap, ...defaultKeymap, ...historyKeymap, indentWithTab]),
            EditorState.tabSize.of(3),
            EditorView.lineWrapping,
            EditorView.contentAttributes.of({
                autocorrect: "off", autocapitalize: "off", spellcheck: "false", "aria-label": "SQL-Editor"
            }),
            // Stern per Tastatur: Leerzeichen dahinter (siehe starInsert)
            EditorView.inputHandler.of((view, from, to, text) => {
                if (view.state.readOnly) return false;
                // Leerzeichen direkt nach dem automatisch gesetzten: nicht verdoppeln
                if (text == " " && from == to && from == this.starSpaceAt) { this.starSpaceAt = -1; return true; }
                this.starSpaceAt = -1;
                if (text != "*") return false;
                const insert = starInsert(view.state.doc, from, to);
                if (insert == "*") return false;
                view.dispatch({
                    changes: { from, to, insert },
                    selection: EditorSelection.cursor(from + insert.length),
                    scrollIntoView: true, userEvent: "input.type"
                });
                this.starSpaceAt = from + insert.length;
                return true;
            }),
            EditorView.updateListener.of((u: ViewUpdate) => this.onUpdate(u)),
            this.parking.of([]),
        ];

        this.extensions = extensions;
        this.view = new EditorView({ parent, state: this.createState("") });

        // Semikolon-Engel und verzögerte Prüfungen
        setInterval(() => { if (this.angel.positions.length > 0) this.compileNow(); }, 1000);
    }

    private onUpdate(u: ViewUpdate) {
        if (u.docChanged) {
            if (!this.silent) this.cb.onChange(this.getText());
            if (!this.silent && u.transactions.some(t => t.isUserEvent("input"))) this.maybeOpenTableCompletion();
            this.scheduleCompile();
        } else if (u.selectionSet) {
            if (u.state.selection.main.head != this.starSpaceAt) this.starSpaceAt = -1;
            this.updateStatementMarks();
            this.updateStatus();
        }
    }

    getText(): string { return this.view.state.doc.toString(); }

    /**
     * Nach „from “ bzw. „join “ (getippt, über die Symbolleiste eingefügt oder vervollständigt) das Popup
     * mit den Tabellen der Datenbank sofort öffnen – aber nur am Ende einer Zeile oder vor einem Leerzeichen/Strichpunkt.
     */
    private maybeOpenTableCompletion() {
        const st = this.view.state;
        const sel = st.selection.main;
        if (!sel.empty) return;
        const before = st.sliceDoc(Math.max(0, sel.head - 6), sel.head);
        const after = st.sliceDoc(sel.head, sel.head + 1);
        if (!/\b(from|join) $/i.test(before) || !/^($|[\s;)])/.test(after)) return;
        setTimeout(() => {
            if (this.view.state.selection.main.head != sel.head) return;
            startCompletion(this.view);
        }, 30);
    }

    /** Für die Vervollständigung: immer zum aktuellen Text passend übersetzen (ohne Anzeige zu ändern) */
    upToDateModule(): PadModule | null {
        const text = this.getText();
        if (this.module == null || this.module.text != text) this.module = compile(text, this.db);
        return this.module;
    }

    createState(text: string): EditorState {
        return EditorState.create({ doc: text, extensions: this.extensions });
    }

    /** Wechselt den angezeigten Zustand (eigene Undo-Historie je Skript) */
    setState(state: EditorState) {
        this.silent = true;
        this.view.setState(state);
        this.silent = false;
        this.compileNow();
    }

    getState(): EditorState { return this.view.state; }

    focus() { this.view.focus(); }
    undo() { undo(this.view); }
    redo() { redo(this.view); }

    /** Text an der Cursorposition einfügen (Symbolleiste). "|" markiert die neue Cursorposition. */
    insert(snippet: string) {
        const view = this.view;
        const cursorIndex = snippet.indexOf("|");
        const text = snippet.replace("|", "");
        const sel = view.state.selection.main;
        let insertText = text == "*" ? starInsert(view.state.doc, sel.from, sel.to) : text;
        // bei Schlüsselwörtern automatisch Leerzeichen ergänzen
        if (/^[a-z]/i.test(text) && text.length > 1) {
            const before = view.state.doc.sliceString(Math.max(0, sel.from - 1), sel.from);
            if (before && !/[\s(.,]/.test(before)) insertText = " " + insertText;
            if (!insertText.endsWith(" ") && !insertText.endsWith(".") && cursorIndex < 0) insertText += " ";
        }
        const anchor = sel.from + (cursorIndex >= 0 ? cursorIndex + (insertText.length - text.length) : insertText.length);
        view.dispatch({
            changes: { from: sel.from, to: sel.to, insert: insertText },
            selection: EditorSelection.cursor(anchor),
            scrollIntoView: true, userEvent: "input.type"
        });
        this.starSpaceAt = insertText == "* " ? anchor : -1;
        view.focus();
    }

    /** Ganze Anweisung (z. B. Hilfe-Beispiel) in eine eigene Zeile hinter der aktuellen Zeile einfügen */
    insertBlock(sql: string) {
        const view = this.view;
        const state = view.state;
        const line = state.doc.lineAt(state.selection.main.head);
        const empty = line.text.trim() == "";
        const from = empty ? line.from : line.to;
        const to = empty ? line.to : line.to;
        const insert = (empty ? "" : "\n") + sql;
        // Cursor in die Anweisung setzen, damit „▶ Ausführen“ genau sie ausführt
        view.dispatch({
            changes: { from, to, insert },
            selection: EditorSelection.cursor(from + insert.length - (sql.endsWith(";") ? 1 : 0)),
            scrollIntoView: true, userEvent: "input"
        });
        view.focus();
    }

    /**
     * Anweisungen aus dem Lernpfad ans Ende des Skripts anhängen (mit Leerzeile davor) und den Cursor
     * hineinsetzen, damit „▶ Ausführen“ genau sie ausführt. Ohne focus bleibt die Bildschirmtastatur zu.
     */
    appendBlock(sql: string, focus = false) {
        const view = this.view;
        const doc = view.state.doc;
        const text = doc.toString();
        const trimmedEnd = text.replace(/\s+$/, "");
        const prefix = trimmedEnd.length == 0 ? "" : "\n\n";
        const body = sql.replace(/\s+$/, "");
        const insert = prefix + body + "\n";
        const from = trimmedEnd.length;
        const firstStmtEnd = body.indexOf(";");
        const cursor = from + prefix.length + (firstStmtEnd >= 0 ? firstStmtEnd : body.length);
        view.dispatch({
            changes: { from, to: doc.length, insert },
            selection: EditorSelection.cursor(cursor),
            scrollIntoView: true, userEvent: "input"
        });
        if (focus) view.focus();
        this.compileNow();
    }

    setParked(on: boolean) {
        this.view.dispatch({ effects: this.parking.reconfigure(on ? EditorState.readOnly.of(true) : []) });
    }

    scheduleCompile() {
        clearTimeout(this.compileTimer);
        this.compileTimer = setTimeout(() => this.compileNow(), 250);
    }

    compileNow() {
        clearTimeout(this.compileTimer);
        const text = this.getText();
        this.module = compile(text, this.db, this.angel);
        this.healSemicolons();
        this.showDiagnostics();
        this.updateStatementMarks();
        this.updateStatus();
        this.cb.onCompiled(this.module);
    }

    private healSemicolons() {
        const state = this.view.state;
        const cursorLine = state.doc.lineAt(state.selection.main.head).number;
        const due = this.angel.due(cursorLine);
        if (due.length == 0) return;
        const changes = due.map(p => ({ from: this.toOffset(p.line, p.column), insert: ";" }))
            .filter(c => c.from >= 0 && c.from <= state.doc.length);
        if (changes.length == 0) return;
        this.view.dispatch({ changes, userEvent: "input.semicolon" });
        // neu übersetzen, damit Positionen stimmen
        this.module = compile(this.getText(), this.db, this.angel);
    }

    toOffset(line: number, column: number): number {
        const doc = this.view.state.doc;
        if (line < 1) return 0;
        if (line > doc.lines) return doc.length;
        const l = doc.line(line);
        return Math.min(l.to, l.from + Math.max(0, column - 1));
    }

    private showDiagnostics() {
        const diagnostics: Diagnostic[] = [];
        for (const e of this.module.getSortedAndFilteredErrors()) {
            const from = this.toOffset(e.position.line, e.position.column);
            let to = Math.min(this.view.state.doc.length, from + Math.max(1, e.position.length));
            if (to <= from) to = Math.min(this.view.state.doc.length, from + 1);
            diagnostics.push({
                from, to: Math.max(from, to),
                severity: e.level == "error" ? "error" : e.level == "warning" ? "warning" : "info",
                message: e.text
            });
        }
        this.view.dispatch(setDiagnostics(this.view.state, diagnostics));
    }

    /** Anweisungen, die ausgeführt werden: alle, die die Auswahl berühren (sonst die vor dem Cursor) */
    getSelectedStatements(): SQLStatement[] {
        if (this.module == null) this.compileNow();
        const state = this.view.state;
        const sel = state.selection.main;
        const pos = (offset: number) => {
            const l = state.doc.lineAt(offset);
            return { line: l.number, column: offset - l.from + 1 };
        };
        let statements = this.module.getStatementsAtSelection(pos(sel.from), pos(sel.to));
        if (statements.length == 0 && sel.empty) {
            // Cursor zwischen zwei Anweisungen: die letzte Anweisung davor nehmen
            const p = pos(sel.from);
            const before = this.module.sqlStatements.filter(s => s.to != null && (s.to.line < p.line || (s.to.line == p.line && s.to.column <= p.column)));
            if (before.length > 0) statements = [before[before.length - 1]];
            else if (this.module.sqlStatements.length > 0) statements = [this.module.sqlStatements[0]];
        }
        return statements.filter(s => s.from != null);
    }

    getAllStatements(): SQLStatement[] {
        if (this.module == null) this.compileNow();
        return this.module.sqlStatements.filter(s => s.from != null);
    }

    sqlOf(statement: SQLStatement): string {
        return this.view.state.sliceDoc(this.toOffset(statement.from.line, statement.from.column), this.toOffset(statement.to.line, statement.to.column));
    }

    private updateStatementMarks() {
        if (this.module == null) return;
        const builder = new RangeSetBuilder<Decoration>();
        const doc = this.view.state.doc;
        const statements = this.getSelectedStatements();
        const lines: { n: number, cls: string }[] = [];
        for (const st of statements) {
            const cls = st.hasErrors ? "cm-stmt-error" : "cm-stmt-ok";
            for (let n = st.from.line; n <= Math.min(st.to.line, doc.lines); n++) lines.push({ n, cls });
        }
        lines.sort((a, b) => a.n - b.n);
        let last = -1;
        for (const { n, cls } of lines) {
            if (n == last) continue;
            last = n;
            const l = doc.line(n);
            builder.add(l.from, l.from, Decoration.line({ class: cls }));
        }
        this.view.dispatch({ effects: setStatementMarks.of(builder.finish()) });
    }

    private updateStatus() {
        if (this.module == null) return;
        const state = this.view.state;
        const cursorLine = state.doc.lineAt(state.selection.main.head).number;
        const errors = this.module.getSortedAndFilteredErrors();
        const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
        const onLine = errors.filter(e => e.position.line == cursorLine);
        const selected = this.getSelectedStatements();
        const relevant = onLine.length > 0 ? onLine
            : errors.filter(e => selected.some(s => e.position.line >= s.from.line && e.position.line <= s.to.line));
        if (relevant.length > 0) {
            const e = relevant[0];
            this.cb.onStatus(`<b>Zeile ${e.position.line}:</b> ${esc(e.text)}`, e.level == "error" ? "error" : e.level == "warning" ? "warning" : "info");
        } else if (errors.filter(e => e.level == "error").length > 0) {
            const n = errors.filter(e => e.level == "error").length;
            this.cb.onStatus(`${n} Fehler im Skript – tippe hier, um zum nächsten zu springen.`, "warning");
        } else {
            const n = this.module.sqlStatements.length;
            this.cb.onStatus(n == 0 ? "Gib eine SQL-Anweisung ein." : `${n} Anweisung${n == 1 ? "" : "en"}, keine Fehler.`, "ok");
        }
    }

    gotoNextError() {
        if (!this.module) return;
        const errors = this.module.getSortedAndFilteredErrors();
        if (errors.length == 0) return;
        const head = this.view.state.selection.main.head;
        const offsets = errors.map(e => this.toOffset(e.position.line, e.position.column));
        const next = offsets.find(o => o > head) ?? offsets[0];
        this.view.dispatch({ selection: EditorSelection.cursor(next), scrollIntoView: true });
        this.view.focus();
    }

    revealStatement(st: SQLStatement) {
        const from = this.toOffset(st.from.line, st.from.column);
        this.view.dispatch({ selection: EditorSelection.cursor(from), scrollIntoView: true });
    }
}
