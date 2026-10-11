/**
 * Kontextsensitive Code-Vervollständigung – Portierung von src/client/main/gui/MyCompletionItemProvider.ts
 * auf CodeMirror 6. Grundlage sind die "CompletionHints", die Parser und SymbolResolver der SQL-IDE erzeugen.
 */
import { Completion, CompletionContext, CompletionResult, snippetCompletion } from "@codemirror/autocomplete";
import { TokenType } from "../../src/client/compiler/lexer/Token.js";
import type { Symbol, SymbolTable } from "../../src/client/compiler/parser/SymbolTable.js";
import type { CompletionHint, PadModule } from "./module.js";

const statementTemplates: { [kw: string]: Completion } = {
    "SELECT": snippetCompletion("select ${} from ${}\nwhere ${};", { label: "select … from … where …", detail: "Abfrage", type: "keyword", boost: 10 }),
    "CREATE TABLE": snippetCompletion("create table ${name} (\n\t${}\n);", { label: "create table …", detail: "neue Tabelle", type: "keyword" }),
    "DELETE FROM": snippetCompletion("delete from ${} where ${};", { label: "delete from … where …", detail: "Datensätze löschen", type: "keyword" }),
    "DROP TABLE": snippetCompletion("drop table ${};", { label: "drop table …", detail: "Tabelle löschen", type: "keyword" }),
    "ALTER TABLE": snippetCompletion("alter table ${} ", { label: "alter table …", detail: "Schema ändern", type: "keyword" }),
    "INSERT INTO": snippetCompletion("insert into ${} (${}) values (${});", { label: "insert into … values …", detail: "Datensatz einfügen", type: "keyword" }),
    "UPDATE": snippetCompletion("update ${} set ${} where ${};", { label: "update … set … where …", detail: "Datensätze ändern", type: "keyword" }),
    "CREATE VIEW": snippetCompletion("create view ${name} as\nselect ${};", { label: "create view …", detail: "Sicht anlegen", type: "keyword" }),
};

const keywordSnippets: { [kw: string]: Completion } = {
    "(": snippetCompletion("(\n\t${}\n)", { label: "( … )", type: "keyword" }),
    "VARCHAR": snippetCompletion("varchar(${}) ", { label: "varchar(…)", type: "type" }),
    "DECIMAL": snippetCompletion("decimal(${}, ${}) ", { label: "decimal(…, …)", type: "type" }),
};

export function makeCompletionSource(getModule: () => PadModule | null) {
    return (context: CompletionContext): CompletionResult | null => {
        const module = getModule();
        if (module == null || module.mainSymbolTable == null) return null;

        const pos = context.pos;
        const line = context.state.doc.lineAt(pos);
        const lineNumber = line.number;
        const column = pos - line.from + 1;

        if (isStringLiteral(module, lineNumber, column)) return null;

        const word = context.matchBefore(/[\wäöüÄÖÜß]*/);
        const dotMatch = context.matchBefore(/[\wäöüÄÖÜß]+\.[\wäöüÄÖÜß]*/);
        if (!context.explicit && word && word.from == word.to && !dotMatch) {
            // nur nach Leerzeichen/Komma/Klammer automatisch öffnen, wenn es einen passenden Hinweis gibt
            const before = line.text.substring(0, column - 1);
            if (!/[\s,(]$/.test(before)) return null;
        }

        const symbolTable: SymbolTable = module.mainSymbolTable.findTableAtPosition(lineNumber, column);
        const hint: CompletionHint = module.getCompletionHint(lineNumber, column) ?? {
            fromColumn: 0, toColumn: 0, fromLine: 0, toLine: 0, hintColumns: false, hintTables: false, hintKeywords: []
        };

        let options: Completion[] = [];

        if (dotMatch) {
            const [before] = dotMatch.text.split(".");
            addDotCompletions(before.toLowerCase(), symbolTable, options);
            if (options.length == 0) return null;
            return { from: dotMatch.from + before.length + 1, options, validFor: /^[\wäöüÄÖÜß]*$/ };
        }

        addKeywordCompletions(hint, options);
        addIdentifierCompletions(hint, symbolTable, options);

        if (hint.dontHint != null) options = options.filter(o => hint.dontHint.indexOf((o.apply as string) ?? o.label) < 0);
        if (options.length == 0) return null;
        if (!context.explicit && word.from == word.to && options.length > 60) return null;

        return { from: word.from, options, validFor: /^[\wäöüÄÖÜß]*$/ };
    };
}

function addDotCompletions(textBeforeDot: string, symbolTable: SymbolTable, options: Completion[]) {
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
        const tpl = statementTemplates[kw] ?? keywordSnippets[kw];
        if (tpl) { options.push(tpl); continue; }
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
