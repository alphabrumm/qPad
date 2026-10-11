/**
 * Syntaxhervorhebung für den CodeMirror-Editor. Die Schlüsselwörter stammen aus dem Lexer der SQL-IDE,
 * damit Hervorhebung und Compiler dieselbe Sprache sprechen.
 */
import { HighlightStyle, StreamLanguage, StringStream, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import { keywordList } from "../../src/client/compiler/lexer/Token.js";

const keywords = new Set(Object.keys(keywordList).map(k => k.toLowerCase()));
const literals = new Set(["true", "false", "null"]);
const types = new Set(["int", "integer", "varchar", "char", "text", "date", "datetime", "time", "float", "double", "real",
    "decimal", "numeric", "boolean", "bool", "bigint", "smallint", "tinyint", "mediumint", "blob", "timestamp", "year", "enum"]);
const functions = new Set(["count", "sum", "avg", "min", "max", "abs", "round", "upper", "lower", "length", "substr", "substring",
    "concat", "coalesce", "ifnull", "year", "month", "day", "now", "date", "strftime", "replace", "trim", "instr", "random", "group_concat"]);

type State = { inComment: boolean };

const sqlStream = StreamLanguage.define<State>({
    name: "sql-ide",
    startState: () => ({ inComment: false }),
    token(stream: StringStream, state: State) {
        if (state.inComment) {
            if (stream.skipTo("*/")) { stream.match("*/"); state.inComment = false; }
            else stream.skipToEnd();
            return "comment";
        }
        if (stream.eatSpace()) return null;
        if (stream.match("--")) { stream.skipToEnd(); return "comment"; }
        if (stream.match("/*")) { state.inComment = true; return "comment"; }

        const ch = stream.peek();
        if (ch == "'" || ch == '"' || ch == "`") {
            const quote = stream.next();
            let escaped = false, c: string | void;
            while ((c = stream.next()) != null) {
                if (c == quote && !escaped) {
                    if (stream.peek() == quote) { stream.next(); continue; }
                    break;
                }
                escaped = !escaped && c == "\\";
            }
            return quote == "'" ? "string" : "variableName.special";
        }
        if (stream.match(/^\d+(\.\d+)?/)) return "number";
        if (stream.match(/^[A-Za-z_äöüÄÖÜß][\wäöüÄÖÜß]*/)) {
            const w = stream.current().toLowerCase();
            if (literals.has(w)) return "atom";
            if (types.has(w)) return "typeName";
            if (functions.has(w) && stream.match(/^\s*\(/, false)) return "function";
            if (keywords.has(w)) return "keyword";
            return "variableName";
        }
        if (stream.match(/^(<=|>=|<>|!=|\|\||[=<>+\-*\/%])/)) return "operator";
        if (stream.match(/^[(),;.]/)) return "punctuation";
        stream.next();
        return null;
    },
    languageData: { commentTokens: { line: "--", block: { open: "/*", close: "*/" } } }
});

const style = HighlightStyle.define([
    { tag: t.keyword, color: "var(--hl-keyword)", fontWeight: "600" },
    { tag: t.typeName, color: "var(--hl-type)" },
    { tag: t.function(t.variableName), color: "var(--hl-function)" },
    { tag: t.string, color: "var(--hl-string)" },
    { tag: t.number, color: "var(--hl-number)" },
    { tag: t.atom, color: "var(--hl-number)", fontWeight: "600" },
    { tag: t.comment, color: "var(--hl-comment)", fontStyle: "italic" },
    { tag: t.special(t.variableName), color: "var(--hl-ident)" },
    { tag: t.operator, color: "var(--hl-operator)" },
    { tag: t.punctuation, color: "var(--hl-punct)" },
]);

export const sqlLanguage = [sqlStream, syntaxHighlighting(style)];

/** Hervorhebung als HTML (für Ergebnis- und Fehlerüberschriften) */
export function highlightToHtml(sql: string): string {
    const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    let html = "";
    const re = /('(?:[^']|'')*'?)|(--.*$)|(\d+(?:\.\d+)?)|([A-Za-z_äöüÄÖÜß][\wäöüÄÖÜß]*)|(\s+)|(.)/gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(sql)) != null) {
        if (m[1]) html += `<span class="hl-string">${esc(m[1])}</span>`;
        else if (m[2]) html += `<span class="hl-comment">${esc(m[2])}</span>`;
        else if (m[3]) html += `<span class="hl-number">${m[3]}</span>`;
        else if (m[4]) {
            const w = m[4].toLowerCase();
            const cls = keywords.has(w) ? "hl-keyword" : literals.has(w) ? "hl-number" : types.has(w) ? "hl-type" : "";
            html += cls ? `<span class="${cls}">${esc(m[4])}</span>` : esc(m[4]);
        } else html += esc(m[0]);
    }
    return html;
}
