/**
 * Ersatz für src/client/compiler/parser/Module.ts ohne Monaco-Abhängigkeit.
 * Enthält genau die Felder und Methoden, die Lexer, Parser und SymbolResolver der SQL-IDE benutzen.
 */
import type { Error, ErrorLevel } from "../../src/client/compiler/lexer/Lexer.js";
import type { TextPosition, Token } from "../../src/client/compiler/lexer/Token.js";
import type { SQLStatement } from "../../src/client/compiler/parser/Parser.js";
import { SymbolTable } from "../../src/client/compiler/parser/SymbolTable.js";

export type CompletionHint = {
    fromLine: number, fromColumn: number, toLine: number, toColumn: number,
    hintColumns: boolean, hintColumnsOfTable?: string, hintTables: boolean,
    hintKeywords: string[], dontHint?: string[], praefix?: string, suffix?: string
};

export interface SemicolonRegistry {
    register(position: TextPosition, module: PadModule): void;
}

export class PadModule {

    errors: Error[][] = [[], [], [], []];
    tokenList: Token[];
    bracketError: string;
    sqlStatements: SQLStatement[] = [];
    mainSymbolTable: SymbolTable;
    completionHints: Map<number, CompletionHint[]> = new Map();
    identifierPositions: { [line: number]: any[] } = {};
    methodCallPositions: { [line: number]: any[] } = {};

    /** Der Parser ruft module.main.getSemicolonAngel().register(...) auf */
    main: { getSemicolonAngel(): SemicolonRegistry };

    constructor(public text: string, semicolonRegistry?: SemicolonRegistry) {
        const reg = semicolonRegistry ?? { register: () => { } };
        this.main = { getSemicolonAngel: () => reg };
        this.clear();
    }

    clear() {
        this.identifierPositions = {};
        this.tokenList = null;
        this.errors = [[], [], [], []];
        this.completionHints = new Map();
        this.mainSymbolTable = new SymbolTable(null, { line: 1, column: 1, length: 1 }, { line: 100000, column: 1, length: 0 });
        this.methodCallPositions = {};
    }

    addCompletionHint(fromPosition: TextPosition, toPosition: TextPosition, hintColumns: boolean | string, hintTables: boolean,
        hintKeywords: string[], dontHint?: string[], praefix: string = "", suffix: string = "") {
        if (fromPosition == null || toPosition == null) return;
        const ch: CompletionHint = {
            fromColumn: fromPosition.column, fromLine: fromPosition.line,
            toColumn: toPosition.column, toLine: toPosition.line,
            hintColumns: (typeof hintColumns == "boolean") ? hintColumns : true,
            hintColumnsOfTable: (typeof hintColumns == "string") ? hintColumns : null,
            hintTables, hintKeywords: hintKeywords == null ? null : hintKeywords.map(s => s.toUpperCase()),
            dontHint, praefix, suffix
        };
        for (let i = ch.fromLine; i <= ch.toLine && i - ch.fromLine < 10000; i++) {
            let list = this.completionHints.get(i);
            if (list == null) { list = []; this.completionHints.set(i, list); }
            list.push(ch);
        }
    }

    getCompletionHint(line: number, column: number): CompletionHint | null {
        let list = this.completionHints.get(line);
        if (list == null || list.length == 0) return null;
        const pos = line * 1000 + column;
        list = list.filter(ch => pos >= ch.fromLine * 1000 + ch.fromColumn && pos <= ch.toLine * 1000 + ch.toColumn);
        if (list.length == 0) return null;
        let best = list[0];
        let bestLen = (best.toLine - best.fromLine) * 1000 + (best.toColumn - best.fromColumn);
        for (const ch of list) {
            const len = (ch.toLine - ch.fromLine) * 1000 + (ch.toColumn - ch.fromColumn);
            if (len < bestLen) { best = ch; bestLen = len; }
        }
        return best;
    }

    addIdentifierPosition(position: TextPosition, element: any) {
        (this.identifierPositions[position.line] ??= []).push({ position, element });
    }

    static compare(a: { line: number, column: number }, b: { line: number, column: number }): number {
        if (a.line != b.line) return a.line > b.line ? 1 : -1;
        if (a.column != b.column) return a.column > b.column ? 1 : -1;
        return 0;
    }

    /** Alle Anweisungen, die den Bereich [selStart, selEnd] berühren (wie in der SQL-IDE) */
    getStatementsAtSelection(selStart: { line: number, column: number }, selEnd: { line: number, column: number }): SQLStatement[] {
        if (this.sqlStatements == null) return [];
        return this.sqlStatements.filter(st => st.from != null && st.to != null &&
            !(PadModule.compare(st.to, selStart) < 0 || PadModule.compare(st.from, selEnd) > 0));
    }

    getSortedAndFilteredErrors(): Error[] {
        let list: Error[] = [];
        for (const el of this.errors) if (el) list = list.concat(el);
        list = list.filter(e => e.position != null);
        list.sort((a, b) => a.position.line != b.position.line ? a.position.line - b.position.line : a.position.column - b.position.column);
        for (let i = 0; i < list.length - 1; i++) {
            const e1 = list[i], e2 = list[i + 1];
            if (e1.position.line == e2.position.line && e1.position.column + 10 > e2.position.column) {
                if (PadModule.errorLevelCompare(e1.level, e2.level) == 1) list.splice(i + 1, 1);
                else list.splice(i, 1);
                i--;
            }
        }
        return list;
    }

    static errorLevelCompare(level1: ErrorLevel, level2: ErrorLevel): number {
        if (level1 == "error") return 1;
        if (level2 == "error") return 2;
        if (level1 == "warning") return 1;
        if (level2 == "warning") return 2;
        return 1;
    }
}
