/**
 * Kontextsensitive Code-Vervollständigung – Portierung von src/client/main/gui/MyCompletionItemProvider.ts
 * auf CodeMirror 6. Grundlage sind die "CompletionHints", die Parser und SymbolResolver der SQL-IDE erzeugen.
 */
import { Completion, CompletionContext, CompletionResult, insertCompletionText, pickedCompletion } from "@codemirror/autocomplete";
import type { EditorView } from "@codemirror/view";
import { TokenType } from "../../src/client/compiler/lexer/Token.js";
import { SQLMethodStore } from "../../src/client/compiler/parser/SQLMethods.js";
import type { Symbol, SymbolTable } from "../../src/client/compiler/parser/SymbolTable.js";
import type { DatabaseStructure } from "./db.js";
import type { CompletionHint, PadModule } from "./module.js";

/*
 * Vervollständigt werden nur einzelne Wörter: Schlüsselwörter, Tabellen und Spalten.
 * Bewusst KEINE Gerüste wie „select … from … where …“ – Enter soll nie mehr einfügen als das Wort.
 */

export function makeCompletionSource(getModule: () => PadModule | null, getStructure: () => DatabaseStructure | null) {
    return (context: CompletionContext): CompletionResult | null => {
        const module = getModule();
        if (module == null || module.mainSymbolTable == null) return null;

        const pos = context.pos;
        const line = context.state.doc.lineAt(pos);
        const lineNumber = line.number;
        const column = pos - line.from + 1;

        if (isStringLiteral(module, lineNumber, column)) return null;

        const word = context.matchBefore(/[\wäöüÄÖÜß]*/);

        // Direkt nach „from “ bzw. „join “: nur die Tabellen der Datenbank anbieten
        // (das Popup öffnet der Editor dort von selbst, siehe SqlEditor.maybeOpenTableCompletion)
        const beforeWord = context.state.sliceDoc(Math.max(0, word.from - 12), word.from);
        if (/\b(from|join)\s+$/i.test(beforeWord) && !context.matchBefore(/[\wäöüÄÖÜß]+\.[\wäöüÄÖÜß]*/)) {
            const tables: Completion[] = [];
            addDatabaseTables(getStructure(), { fromColumn: 0, toColumn: 0, fromLine: 0, toLine: 0, hintColumns: false, hintTables: true, hintKeywords: [] }, tables);
            if (tables.length == 0) return null;
            const typedWord = word.text.toLowerCase();
            if (!context.explicit && typedWord.length > 0 && tables.some(o => o.label.toLowerCase() == typedWord)) return null;
            return { from: word.from, options: tables, validFor: /^[\wäöüÄÖÜß]*$/ };
        }
        const dotMatch = context.matchBefore(/[\wäöüÄÖÜß]+\.[\wäöüÄÖÜß]*/);
        // Automatisch erst öffnen, wenn ein Buchstabe oder ein Punkt getippt wurde
        // (sonst würde Enter nach einem Leerzeichen einen Vorschlag statt eines Zeilenumbruchs einfügen).
        if (!context.explicit && word.from == word.to && !dotMatch) return null;

        const symbolTable: SymbolTable = module.mainSymbolTable.findTableAtPosition(lineNumber, column);
        // Steht vor dem Wort schon etwas (z. B. „select “), gilt nicht mehr der Hinweis für den Anweisungsbeginn
        const textBefore = context.state.sliceDoc(0, word.from);
        const atStatementStart = /(^|;)\s*$/.test(textBefore);
        const hint: CompletionHint = pickHint(module, lineNumber, column, atStatementStart) ?? {
            fromColumn: 0, toColumn: 0, fromLine: 0, toLine: 0, hintColumns: false, hintTables: false, hintKeywords: []
        };

        let options: Completion[] = [];

        if (dotMatch) {
            const [before] = dotMatch.text.split(".");
            addDotCompletions(before.toLowerCase(), symbolTable, getStructure(), options);
            if (options.length == 0) return null;
            return { from: dotMatch.from + before.length + 1, options: options.map(withSpaceIfWanted), validFor: /^[\wäöüÄÖÜß]*$/ };
        }

        addKeywordCompletions(hint, options);
        addIdentifierCompletions(hint, symbolTable, options);
        // Alle Tabellen der Datenbank anbieten – auch wenn (noch) kein „from“ dasteht, z. B. direkt nach „select“
        // Funktionen (length, upper, round …) überall dort, wo eine Spalte stehen kann
        if (hint.hintColumns) addFunctionCompletions(options);
        // – aber nur, wenn noch keine Spalten passen (sonst würden z. B. nach „where“ fremde Tabellen vor den Spalten stehen)
        const columnsOffered = options.some(o => o.type == "property");
        if (!columnsOffered && (hint.hintTables || hint.hintColumns || hint.hintKeywords == null || hint.hintKeywords.length == 0)) {
            addDatabaseTables(getStructure(), hint, options);
        }

        if (hint.dontHint != null) options = options.filter(o => hint.dontHint.indexOf((o.apply as string) ?? o.label) < 0);
        if (options.length == 0) return null;

        // Steht das Wort schon vollständig da, kein Popup: Enter erzeugt dann einen Zeilenumbruch
        const typed = word.text.toLowerCase();
        if (!context.explicit && typed.length > 0 && options.some(o => o.label.toLowerCase() == typed)) return null;

        // Nur Schlüsselwörter (select, from, where, as, …): nach dem Einfügen ein Leerzeichen,
        // damit man direkt weiterschreiben kann. Tabellen und Spalten bleiben ohne Leerzeichen.
        options = options.map(o => o.type == "keyword" ? withTrailingSpace(o) : o);

        options = options.map(withSpaceIfWanted);
        return { from: word.from, options, validFor: /^[\wäöüÄÖÜß]*$/ };
    };
}

/**
 * Schlüsselwörter (select, from, where, as, …) und Spalten bekommen nach dem Einfügen ein Leerzeichen,
 * damit man direkt weiterschreiben kann. Tabellen bleiben ohne Leerzeichen.
 */
/** Kurzbeschreibungen für die Funktionen des SQL-IDE-Compilers (src/client/compiler/parser/SQLMethods.ts) */
const FUNCTION_INFO: { [name: string]: string } = {
    count: "Anzahl der Datensätze", sum: "Summe", avg: "Durchschnitt", min: "kleinster Wert", max: "größter Wert",
    length: "Länge eines Textes", upper: "Text in GROSSBUCHSTABEN", lower: "Text in kleinbuchstaben", concat: "Texte verbinden",
    abs: "Betrag", round: "runden (auch round(x, Stellen))", sin: "Sinus", cos: "Kosinus", tan: "Tangens",
    day: "Tag eines Datums", month: "Monat eines Datums", year: "Jahr eines Datums", strftime: "Datum formatieren",
};

function addFunctionCompletions(options: Completion[]) {
    const names = [...new Set(SQLMethodStore.getInstance().methods.map(m => m.identifier))].sort();
    for (const name of names) {
        options.push({
            label: name + "()", type: "function", detail: FUNCTION_INFO[name] ?? "Funktion", boost: 1,
            // Name und Klammern einfügen, Cursor zwischen die Klammern setzen
            apply: (view: EditorView, c: Completion, from: number, to: number) => {
                const hasParen = view.state.sliceDoc(to, to + 1) == "(";
                const insert = hasParen ? name : name + "()";
                view.dispatch({
                    ...insertCompletionText(view.state, insert, from, to),
                    selection: { anchor: from + name.length + 1 },
                    annotations: pickedCompletion.of(c)
                });
            }
        });
    }
}

function withSpaceIfWanted(o: Completion): Completion {
    if (o.type != "keyword" && o.type != "property") return o;
    const text = typeof o.apply == "string" ? o.apply : o.label;
    return {
        ...o,
        apply: (view: EditorView, _c: Completion, from: number, to: number) => {
            const next = view.state.sliceDoc(to, to + 1);
            // kein doppeltes Leerzeichen und keins vor einer schließenden Klammer: length(name)
            const insert = /^[\s)]$/.test(next) || text.endsWith(" ") ? text : text + " ";
            view.dispatch({
                ...insertCompletionText(view.state, insert, from, to),
                annotations: pickedCompletion.of(o)
            });
        }
    };
}

/** Fügt den Vorschlag ein und setzt dahinter ein Leerzeichen – außer es folgt schon eins */
function withTrailingSpace(o: Completion): Completion {
    const text = typeof o.apply == "string" ? o.apply : o.label;
    return {
        ...o,
        apply: (view: EditorView, _c: Completion, from: number, to: number) => {
            const next = view.state.sliceDoc(to, to + 1);
            const insert = /^\s$/.test(next) || text.endsWith(" ") ? text : text + " ";
            view.dispatch({
                ...insertCompletionText(view.state, insert, from, to),
                annotations: pickedCompletion.of(o)
            });
        }
    };
}

function addDotCompletions(textBeforeDot: string, symbolTable: SymbolTable, structure: DatabaseStructure | null, options: Completion[]) {
    let st = symbolTable;
    while (st != null) {
        for (const symbol of st.symbolList) {
            if (symbol.table == null) continue;
            const identifier = (symbol.tableAlias ?? symbol.table.identifier).toLowerCase();
            if (identifier == textBeforeDot) {
                for (const column of symbol.table.columns) {
                    options.push({ label: column.identifier, detail: "Spalte von " + symbol.table.identifier, type: "property" });
                }
                return;
            }
        }
        st = st.parent;
    }
    // Tabelle steht noch nicht im from-Teil (z. B. „select fluss.“): Spalten aus der Datenbank nehmen
    const table = structure?.tables.find(t => t.name.toLowerCase() == textBeforeDot);
    if (table) {
        for (const c of table.columns) {
            options.push({ label: c.name, detail: "Spalte von " + table.name, type: "property" });
        }
    }
}

const isStatementStartHint = (h: CompletionHint) => h.hintKeywords != null && h.hintKeywords.includes("SELECT") && h.hintKeywords.includes("INSERT INTO");

/** Wie Module.getCompletionHint (kleinster passender Bereich), aber Anweisungsbeginn-Hinweise nur am Anweisungsbeginn */
function pickHint(module: PadModule, line: number, column: number, atStatementStart: boolean): CompletionHint | null {
    const pos = line * 1000 + column;
    let list = (module.completionHints.get(line) ?? [])
        .filter(ch => pos >= ch.fromLine * 1000 + ch.fromColumn && pos <= ch.toLine * 1000 + ch.toColumn);
    if (!atStatementStart && list.some(h => !isStatementStartHint(h))) list = list.filter(h => !isStatementStartHint(h));
    let best: CompletionHint | null = null, bestLen = Infinity;
    for (const ch of list) {
        const len = (ch.toLine - ch.fromLine) * 1000 + (ch.toColumn - ch.fromColumn);
        if (len < bestLen) { best = ch; bestLen = len; }
    }
    return best;
}

function addDatabaseTables(structure: DatabaseStructure | null, hint: CompletionHint, options: Completion[]) {
    if (!structure) return;
    const present = new Set(options.filter(o => o.type == "class").map(o => o.label.toLowerCase()));
    const praefix = hint.praefix ?? "", suffix = hint.suffix ?? "";
    for (const t of structure.tables) {
        if (t.name.startsWith("sqlite_") || present.has(t.name.toLowerCase())) continue;
        options.push({
            label: t.name, apply: praefix + t.name + suffix,
            detail: t.type == "view" ? "Sicht" : "Tabelle", type: "class", boost: 2
        });
    }
}

function addIdentifierCompletions(hint: CompletionHint, symbolTable: SymbolTable, options: Completion[]) {
    const praefix = hint.praefix ?? "", suffix = hint.suffix ?? "";
    if (!(hint.hintTables || hint.hintColumns)) return;

    const tableIdentifiers: { [id: string]: boolean } = {};
    const columns: { [id: string]: Symbol[] } = {};
    const columnIdentifiers: string[] = [];

    let st = symbolTable;
    while (st != null) {
        for (const symbol of st.symbolList) {
            if (symbol.column != null) {
                const ci = symbol.column.identifier;
                if (columns[ci] == null) { columns[ci] = [symbol]; columnIdentifiers.push(ci); }
                else columns[ci].push(symbol);
            } else if (symbol.table != null && hint.hintTables && !tableIdentifiers[symbol.identifier]) {
                options.push({
                    label: symbol.identifier, apply: praefix + symbol.identifier + suffix,
                    detail: "Tabelle", type: "class", boost: 2
                });
                tableIdentifiers[symbol.identifier] = true;
            }
        }
        st = st.parent;
    }

    if (hint.hintColumns) {
        for (const ci of columnIdentifiers) {
            const list = columns[ci];
            const withTable = list.length > 1 && hint.hintColumnsOfTable == null;
            for (const cs of list) {
                let text = cs.identifier;
                if (withTable && cs.identifier == cs.column.identifier.toLowerCase()) {
                    text = (cs.tableAlias == null ? cs.column.table.identifier : cs.tableAlias) + "." + text;
                }
                if (hint.hintColumnsOfTable == null || cs.column?.table?.identifier == hint.hintColumnsOfTable) {
                    options.push({
                        label: text, apply: praefix + text + suffix,
                        detail: "Spalte von " + cs.column.table.identifier, type: "property", boost: 3
                    });
                }
            }
        }
    }
}

function addKeywordCompletions(hint: CompletionHint, options: Completion[]) {
    if (hint.hintKeywords == null) return;
    const praefix = hint.praefix ?? "", suffix = hint.suffix ?? "";
    for (const kw of hint.hintKeywords) {
        if (!/^[A-Za-z]/.test(kw)) continue;   // „(“, „*“ usw. nicht vorschlagen
        const text = kw.toLowerCase();
        options.push({ label: text, apply: praefix + text + suffix, type: "keyword", boost: text == "from" ? 5 : 0 });
    }
}

function isStringLiteral(module: PadModule, line: number, column: number): boolean {
    const tokens = module.tokenList;
    if (tokens == null) return false;
    for (const tok of tokens) {
        const p = tok.position;
        if (p.line > line) return false;
        if (p.line == line && p.column < column && column <= p.column + p.length && tok.tt == TokenType.stringConstant) return true;
    }
    return false;
}
