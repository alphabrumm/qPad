import { Lexer } from "../../src/client/compiler/lexer/Lexer.js";
import { Parser } from "../../src/client/compiler/parser/Parser.js";
import { SymbolResolver } from "../../src/client/compiler/parser/SymbolResolver.js";
import { StatementCleaner } from "../../src/client/compiler/parser/StatementCleaner.js";
import { EditorView } from "@codemirror/view";
import { autocompletion } from "@codemirror/autocomplete";
import { linter } from "@codemirror/lint";
import { StreamLanguage } from "@codemirror/language";
console.log(Lexer, Parser, SymbolResolver, StatementCleaner, EditorView, autocompletion, linter, StreamLanguage);
