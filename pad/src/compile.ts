/**
 * Ruft den unveränderten SQL-IDE-Compiler auf (Lexer -> Parser -> SymbolResolver)
 * und enthält den "Semikolon-Engel", der vergessene Semikolons nach kurzer Zeit ergänzt.
 */
import { Lexer } from "../../src/client/compiler/lexer/Lexer.js";
import type { TextPosition } from "../../src/client/compiler/lexer/Token.js";
import { Parser } from "../../src/client/compiler/parser/Parser.js";
import { SymbolResolver } from "../../src/client/compiler/parser/SymbolResolver.js";
import type { PadDatabase } from "./db.js";
import { PadModule, SemicolonRegistry } from "./module.js";

type SemicolonPosition = { position: TextPosition, firstSeenMs: number, isThereAgain: boolean };

export class SemicolonAngel implements SemicolonRegistry {
    positions: SemicolonPosition[] = [];
    private time = 0;
    enabled = true;

    startRegistering() {
        this.positions.forEach(p => p.isThereAgain = false);
        this.time = Date.now();
    }

    register(position: TextPosition) {
        const old = this.positions.find(p => p.position.line == position.line && p.position.column == position.column);
        if (old) old.isThereAgain = true;
        else this.positions.push({ position, firstSeenMs: this.time, isThereAgain: true });
    }

    /** Liefert Positionen, an denen jetzt ein Semikolon eingefügt werden soll (nicht in der Nähe des Cursors). */
    due(cursorLine: number): TextPosition[] {
        this.positions = this.positions.filter(p => p.isThereAgain);
        if (!this.enabled) return [];
        const now = Date.now();
        const result: TextPosition[] = [];
        for (const p of this.positions.slice()) {
            if (now - p.firstSeenMs > 2000 && Math.abs(cursorLine - p.position.line) > 1) {
                result.push(p.position);
                this.positions.splice(this.positions.indexOf(p), 1);
            }
        }
        return result;
    }
}

export function compile(text: string, db: PadDatabase, angel?: SemicolonAngel): PadModule {
    const module = new PadModule(text, angel);
    angel?.startRegistering();

    const lexed = new Lexer().lex(text);
    module.errors[0] = lexed.errors;
    module.tokenList = lexed.tokens;
    module.bracketError = lexed.bracketError;

    try {
        new Parser().parse(module as any);
        new SymbolResolver(db as any).start(module as any);
    } catch (e) {
        console.error("Compilerfehler", e);
    }
    return module;
}
