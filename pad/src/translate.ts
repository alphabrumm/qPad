/** Übersetzt häufige SQLite-Fehlermeldungen ins Deutsche (Originaltext bleibt in Klammern erhalten). */
const rules: [RegExp, (m: RegExpMatchArray) => string][] = [
    [/UNIQUE constraint failed: (.*)/i, m => `Der Wert in ${m[1]} ist schon vorhanden – Primärschlüssel und UNIQUE-Spalten dürfen keine doppelten Werte enthalten.`],
    [/FOREIGN KEY constraint failed/i, () => `Fremdschlüssel verletzt: Der Datensatz verweist auf einen nicht vorhandenen Datensatz, oder auf ihn verweisen noch andere Datensätze.`],
    [/NOT NULL constraint failed: (.*)/i, m => `Die Spalte ${m[1]} darf nicht leer (NULL) sein.`],
    [/CHECK constraint failed: (.*)/i, m => `Der Wert verletzt die Bedingung (CHECK) ${m[1]}.`],
    [/no such table: (.*)/i, m => `Die Tabelle ${m[1]} gibt es nicht.`],
    [/no such column: (.*)/i, m => `Die Spalte ${m[1]} gibt es nicht.`],
    [/table (.*) already exists/i, m => `Die Tabelle ${m[1]} gibt es schon.`],
    [/view (.*) already exists/i, m => `Die Sicht ${m[1]} gibt es schon.`],
    [/ambiguous column name: (.*)/i, m => `Der Spaltenname ${m[1]} ist mehrdeutig – schreibe Tabelle.Spalte.`],
    [/near "(.*)": syntax error/i, m => `Syntaxfehler bei „${m[1]}“.`],
    [/(\d+) values for (\d+) columns/i, m => `Es wurden ${m[1]} Werte für ${m[2]} Spalten angegeben.`],
    [/table (.*) has (\d+) columns but (\d+) values were supplied/i, m => `Die Tabelle ${m[1]} hat ${m[2]} Spalten, es wurden aber ${m[3]} Werte angegeben.`],
    [/misuse of aggregate( function)?:? ?(.*)/i, m => `Aggregatfunktion ${m[2]} falsch verwendet (z. B. in WHERE statt HAVING).`],
];

export function translateSqliteError(msg: string): string {
    const clean = msg.replace(/^Error:\s*/, "");
    for (const [re, f] of rules) {
        const m = clean.match(re);
        if (m) return `${f(m)} (SQLite: ${clean})`;
    }
    return clean;
}
