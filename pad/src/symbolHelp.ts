/**
 * Kurzhilfen zur Symbolleiste (lange auf einen Button drücken).
 * Alle Beispiele passen zur Vorlage „Terra (Geographie)“:
 *   land(LNR, Name, KNR, Einwohner [Mio.], Flaeche [km²], HauptONR)   kontinent(KNR, Name, …)
 *   ort(ONR, Name, LNR, Landesteil, Einwohner, …)   fluss(FNR, Name, ZielFNR, Meer, Laenge)
 *   stadtfluss(ONR, FNR)   sprache(SNR, Name)   gesprochen(SNR, LNR, Anteil)   weg(ONR1, ONR2, Strecke, Dauer, Sperrung)
 */
export type SymbolHelp = {
    kind: "Zeichen" | "Operator" | "Schlüsselwort" | "Funktion" | "Datentyp";
    text: string;
    simple: string;
    advanced: string;
    note?: string;
};

const paren: SymbolHelp = {
    kind: "Zeichen",
    text: "Runde Klammern umschließen die Werte einer Funktion (z. B. count(*)) oder legen fest, was zuerst ausgewertet wird.",
    simple: "select count(*) from land;",
    advanced: "select name, knr from land\nwhere (knr = 'EU' or knr = 'AF') and einwohner > 60;",
    note: "and bindet stärker als or – ohne Klammern käme ein anderes Ergebnis heraus.",
};

export const SYMBOL_HELP: Record<string, SymbolHelp> = {
    ";": {
        kind: "Zeichen",
        text: "Das Semikolon beendet eine SQL-Anweisung – so weiß QPad, wo die nächste Anweisung beginnt.",
        simple: "select * from kontinent;",
        advanced: "select name from land where knr = 'EU';\nselect name from fluss where laenge > 3000;",
        note: "„Alle“ führt beide Anweisungen nacheinander aus.",
    },
    ",": {
        kind: "Zeichen",
        text: "Das Komma trennt mehrere Spalten, Werte oder Sortierkriterien voneinander.",
        simple: "select name, einwohner from land;",
        advanced: "select name, knr, einwohner from land\norder by knr, einwohner desc;",
    },
    "(": paren,
    ")": paren,
    "*": {
        kind: "Operator",
        text: "Nach select bedeutet * „alle Spalten“; in einer Rechnung ist * das Malzeichen.",
        simple: "select * from kontinent;",
        advanced: "select name, einwohner * 1000000 as personen\nfrom land where knr = 'EU';",
        note: "In der Tabelle land steht die Einwohnerzahl in Millionen.",
    },
    "=": {
        kind: "Operator",
        text: "Das Gleichheitszeichen prüft, ob zwei Werte gleich sind (bei update weist es einen neuen Wert zu).",
        simple: "select * from land where name = 'Deutschland';",
        advanced: "select o.name, o.einwohner\nfrom ort o join land l on o.lnr = l.lnr\nwhere l.name = 'Österreich' and o.einwohner > 100000;",
    },
    "<": {
        kind: "Operator",
        text: "„kleiner als“: Die Bedingung ist erfüllt, wenn der linke Wert kleiner ist als der rechte.",
        simple: "select name, flaeche from land where flaeche < 1000;",
        advanced: "select name, laenge from fluss\nwhere laenge < 500 and meer = 'Nordsee'\norder by laenge;",
    },
    ">": {
        kind: "Operator",
        text: "„größer als“: Die Bedingung ist erfüllt, wenn der linke Wert größer ist als der rechte.",
        simple: "select name, einwohner from ort where einwohner > 5000000;",
        advanced: "select knr, count(*) as anzahl from land\ngroup by knr\nhaving count(*) > 40;",
    },
    "<>": {
        kind: "Operator",
        text: "„ungleich“: Die Bedingung ist erfüllt, wenn die beiden Werte verschieden sind.",
        simple: "select name, knr from land where knr <> 'EU';",
        advanced: "select name, meer, laenge from fluss\nwhere meer <> 'Nordsee' and laenge > 3000;",
        note: "Leere Felder (null) werden auch von <> nicht gefunden – dafür gibt es is null.",
    },
    "''": {
        kind: "Zeichen",
        text: "Hochkommas umschließen Texte (Zeichenketten); Zahlen stehen ohne Hochkommas.",
        simple: "select * from land where name = 'Frankreich';",
        advanced: "select name, einwohner from ort\nwhere landesteil = 'Bayern' and einwohner > 100000\norder by einwohner desc;",
    },
    ".": {
        kind: "Zeichen",
        text: "Der Punkt verbindet Tabellen- und Spaltenname (land.name) – nötig, wenn zwei Tabellen eine gleich benannte Spalte haben.",
        simple: "select land.name, land.einwohner from land;",
        advanced: "select l.name, k.name\nfrom land l join kontinent k on l.knr = k.knr;",
    },
    "_": {
        kind: "Zeichen",
        text: "Bei like steht der Unterstrich für genau ein beliebiges Zeichen.",
        simple: "select name from land where name like 'I___';",
        advanced: "select name, laenge from fluss\nwhere name like '_n%'\norder by laenge desc;",
        note: "'_n%' heißt: an zweiter Stelle ein n, danach beliebig viel.",
    },
    "%": {
        kind: "Zeichen",
        text: "Bei like steht das Prozentzeichen für beliebig viele (auch gar keine) Zeichen.",
        simple: "select name from land where name like 'S%';",
        advanced: "select name, einwohner from ort\nwhere lnr = 'D' and name like '%burg'\norder by einwohner desc;",
    },

    "select": {
        kind: "Schlüsselwort",
        text: "Mit select legst Du fest, welche Spalten (oder berechneten Werte) im Ergebnis erscheinen.",
        simple: "select name from kontinent;",
        advanced: "select name, round(einwohner * 1000000 / flaeche) as dichte\nfrom land\norder by dichte desc limit 5;",
    },
    "from": {
        kind: "Schlüsselwort",
        text: "from gibt an, aus welcher Tabelle (oder welchen Tabellen) die Daten stammen.",
        simple: "select * from fluss;",
        advanced: "select l.name, k.name\nfrom land l, kontinent k\nwhere l.knr = k.knr;",
        note: "Zwei Tabellen hinter from bilden das Kreuzprodukt – die where-Bedingung wählt die passenden Paare aus.",
    },
    "where": {
        kind: "Schlüsselwort",
        text: "where filtert die Zeilen: Nur Datensätze, die die Bedingung erfüllen, kommen ins Ergebnis.",
        simple: "select * from fluss where name = 'Donau';",
        advanced: "select name, einwohner from ort\nwhere lnr = 'D' and einwohner > 500000\norder by einwohner desc;",
    },
    "and": {
        kind: "Operator",
        text: "Mit and verknüpfte Bedingungen müssen alle gleichzeitig erfüllt sein.",
        simple: "select name from land where knr = 'EU' and einwohner > 50;",
        advanced: "select name, laenge, meer from fluss\nwhere laenge > 1000 and laenge < 2000 and meer = 'Nordsee';",
    },
    "or": {
        kind: "Operator",
        text: "Mit or verknüpfte Bedingungen: Es genügt, wenn mindestens eine erfüllt ist.",
        simple: "select * from fluss where name = 'Donau' or name = 'Rhein';",
        advanced: "select name, knr, einwohner from land\nwhere (knr = 'EU' or knr = 'AF') and einwohner > 60;",
        note: "Klammern nicht vergessen: and wird sonst vor or ausgewertet.",
    },
    "not": {
        kind: "Operator",
        text: "not kehrt eine Bedingung um: Gefunden wird alles, was die Bedingung nicht erfüllt.",
        simple: "select name, knr from land where not knr = 'EU';",
        advanced: "select name, laenge from fluss\nwhere meer is not null and name not like '%a%';",
    },
    "join": {
        kind: "Schlüsselwort",
        text: "join verknüpft zwei Tabellen, deren Zeilen über einen Fremdschlüssel zusammengehören.",
        simple: "select land.name, kontinent.name\nfrom land join kontinent on land.knr = kontinent.knr;",
        advanced: "select o.name\nfrom ort o\n  join stadtfluss sf on o.onr = sf.onr\n  join fluss f on sf.fnr = f.fnr\nwhere f.name = 'Donau';",
        note: "Die Tabelle stadtfluss verbindet Orte und Flüsse (n:m-Beziehung).",
    },
    "on": {
        kind: "Schlüsselwort",
        text: "on gibt beim join an, welche Spalten der beiden Tabellen übereinstimmen müssen.",
        simple: "select l.name, k.name\nfrom land l join kontinent k on l.knr = k.knr;",
        advanced: "select l.name as land, o.name as hauptstadt\nfrom land l join ort o on l.hauptonr = o.onr\nwhere l.knr = 'EU';",
    },
    "as": {
        kind: "Schlüsselwort",
        text: "as gibt einer Spalte oder Tabelle einen neuen, oft kürzeren Namen (Alias).",
        simple: "select name as land, einwohner as mio_einwohner from land;",
        advanced: "select k.name as kontinent, count(*) as anzahl_laender\nfrom land as l join kontinent as k on l.knr = k.knr\ngroup by k.name;",
    },
    "group by": {
        kind: "Schlüsselwort",
        text: "group by fasst alle Zeilen mit gleichem Wert zu einer Gruppe zusammen – meist zusammen mit count, sum, avg, min oder max.",
        simple: "select knr, count(*) from land group by knr;",
        advanced: "select k.name, sum(l.einwohner) as einwohner_mio\nfrom land l join kontinent k on l.knr = k.knr\ngroup by k.name\norder by einwohner_mio desc;",
    },
    "having": {
        kind: "Schlüsselwort",
        text: "having filtert nach dem group by ganze Gruppen (where filtert dagegen vorher einzelne Zeilen).",
        simple: "select knr, count(*) from land\ngroup by knr having count(*) > 40;",
        advanced: "select meer, count(*) as anzahl, round(avg(laenge)) as mittel\nfrom fluss where meer is not null\ngroup by meer having count(*) >= 5\norder by anzahl desc;",
    },
    "order by": {
        kind: "Schlüsselwort",
        text: "order by sortiert das Ergebnis – aufsteigend (Standard) oder mit desc absteigend.",
        simple: "select name from land order by name;",
        advanced: "select knr, name, einwohner from land\norder by knr, einwohner desc;",
        note: "Erst nach Kontinent sortieren, innerhalb eines Kontinents nach Einwohnern.",
    },
    "desc": {
        kind: "Schlüsselwort",
        text: "desc hinter order by sortiert absteigend, also vom größten zum kleinsten Wert (bzw. von Z nach A).",
        simple: "select name, laenge from fluss order by laenge desc;",
        advanced: "select name, einwohner from ort\nwhere lnr = 'D'\norder by einwohner desc limit 10;",
    },
    "count": {
        kind: "Funktion",
        text: "count zählt Zeilen: count(*) alle Zeilen, count(spalte) nur die Zeilen, in denen die Spalte nicht leer ist.",
        simple: "select count(*) from land;",
        advanced: "select knr, count(*) as anzahl from land\ngroup by knr\norder by anzahl desc;",
    },
    "sum": {
        kind: "Funktion",
        text: "sum addiert alle Werte einer Spalte.",
        simple: "select sum(einwohner) from land;",
        advanced: "select knr, sum(flaeche) as gesamtflaeche from land\ngroup by knr\norder by gesamtflaeche desc;",
    },
    "avg": {
        kind: "Funktion",
        text: "avg berechnet den Durchschnitt (Mittelwert) aller Werte einer Spalte.",
        simple: "select avg(laenge) from fluss;",
        advanced: "select knr, round(avg(einwohner), 2) as mittel from land\ngroup by knr\norder by mittel desc;",
    },
    "min": {
        kind: "Funktion",
        text: "min liefert den kleinsten Wert einer Spalte.",
        simple: "select min(flaeche) from land;",
        advanced: "select name, flaeche from land\nwhere flaeche = (select min(flaeche) from land);",
        note: "Die innere Abfrage (Unterabfrage) bestimmt zuerst den kleinsten Wert.",
    },
    "max": {
        kind: "Funktion",
        text: "max liefert den größten Wert einer Spalte.",
        simple: "select max(laenge) from fluss;",
        advanced: "select knr, max(einwohner) as groesstes_land from land\ngroup by knr;",
    },
    "length": {
        kind: "Funktion",
        text: "length gibt an, aus wie vielen Zeichen ein Text besteht.",
        simple: "select name, length(name) from land;",
        advanced: "select name, length(name) as zeichen from land\nwhere length(name) > 20\norder by zeichen desc;",
    },
    "distinct": {
        kind: "Schlüsselwort",
        text: "distinct hinter select entfernt doppelte Zeilen aus dem Ergebnis.",
        simple: "select distinct meer from fluss;",
        advanced: "select distinct landesteil from ort\nwhere lnr = 'D'\norder by landesteil;",
    },
    "like": {
        kind: "Operator",
        text: "like vergleicht Texte mit einem Muster: % steht für beliebig viele Zeichen, _ für genau eines.",
        simple: "select name from land where name like 'B%';",
        advanced: "select name, einwohner from ort\nwhere lnr = 'D' and name like '%stadt'\norder by einwohner desc;",
    },
    "in": {
        kind: "Operator",
        text: "in prüft, ob ein Wert in einer Liste (oder im Ergebnis einer Unterabfrage) vorkommt.",
        simple: "select * from fluss where name in ('Donau', 'Rhein', 'Elbe');",
        advanced: "select name from land\nwhere lnr in (select lnr from gesprochen where snr = 'GER');",
        note: "Ergebnis: alle Länder, in denen Deutsch gesprochen wird.",
    },
    "between": {
        kind: "Operator",
        text: "between prüft, ob ein Wert in einem Bereich liegt – die beiden Grenzen gehören dazu.",
        simple: "select name, laenge from fluss where laenge between 500 and 1000;",
        advanced: "select name, einwohner from land\nwhere knr = 'EU' and einwohner between 5 and 10\norder by einwohner;",
    },
    "is null": {
        kind: "Operator",
        text: "is null findet leere Felder (null) – ein Vergleich mit = null funktioniert dafür nicht.",
        simple: "select name from fluss where meer is null;",
        advanced: "select name, meer, laenge from fluss\nwhere meer is not null\norder by laenge desc limit 5;",
        note: "Flüsse ohne Meer münden in einen anderen Fluss.",
    },
    "limit": {
        kind: "Schlüsselwort",
        text: "limit begrenzt die Anzahl der Zeilen im Ergebnis.",
        simple: "select * from ort limit 10;",
        advanced: "select name, einwohner from ort\norder by einwohner desc limit 5;",
        note: "Zusammen mit order by ergibt das eine „Top 5“-Liste.",
    },
    "insert into": {
        kind: "Schlüsselwort",
        text: "insert into fügt einen neuen Datensatz in eine Tabelle ein.",
        simple: "insert into sprache values ('KLI', 'Klingonisch');",
        advanced: "insert into fluss (fnr, name, zielfnr, laenge)\nvalues ('PND', 'Pandabach', 'ISA', 12);",
        note: "Mit „↶ Daten“ machst Du die Änderung wieder rückgängig.",
    },
    "values": {
        kind: "Schlüsselwort",
        text: "values liefert bei insert into die neuen Werte – in derselben Reihenfolge wie die Spalten.",
        simple: "insert into sprache values ('ELB', 'Elbisch');",
        advanced: "insert into sprache (snr, name)\nvalues ('DOT', 'Dothraki'), ('NAV', 'Na’vi');",
        note: "Mehrere Klammern hintereinander fügen mehrere Datensätze auf einmal ein.",
    },
    "update": {
        kind: "Schlüsselwort",
        text: "update ändert Werte in vorhandenen Datensätzen – die where-Bedingung legt fest, in welchen.",
        simple: "update land set einwohner = 84.4 where lnr = 'D';",
        advanced: "update ort set einwohner = einwohner + 1000\nwhere lnr = 'D' and landesteil = 'Bayern';",
        note: "Ohne where wird jede Zeile der Tabelle geändert!",
    },
    "set": {
        kind: "Schlüsselwort",
        text: "set gibt bei update an, welche Spalte welchen neuen Wert bekommt.",
        simple: "update fluss set laenge = 2857 where name = 'Donau';",
        advanced: "update weg set sperrung = 1, dauer = dauer + 30\nwhere onr1 = 'PIRMAS';",
    },
    "delete from": {
        kind: "Schlüsselwort",
        text: "delete from löscht alle Datensätze, die die where-Bedingung erfüllen.",
        simple: "delete from sprache where snr = 'KLI';",
        advanced: "delete from weg\nwhere dauer > 30 or sperrung = 1;",
        note: "Ohne where wird die ganze Tabelle geleert – „↶ Daten“ hilft dann weiter.",
    },
    "create table": {
        kind: "Schlüsselwort",
        text: "create table legt eine neue Tabelle mit ihren Spalten und Datentypen an.",
        simple: "create table schueler (\n  sid integer primary key,\n  name varchar(30)\n);",
        advanced: "create table besuch (\n  bid integer primary key,\n  onr varchar(6) references ort(onr),\n  datum date,\n  personen integer not null\n);",
    },
    "primary key": {
        kind: "Schlüsselwort",
        text: "Der Primärschlüssel kennzeichnet die Spalte(n), durch die jeder Datensatz eindeutig bestimmt ist.",
        simple: "create table klasse (\n  kid integer primary key,\n  bezeichnung varchar(5)\n);",
        advanced: "create table teilnahme (\n  sid integer,\n  kurs varchar(10),\n  primary key (sid, kurs)\n);",
        note: "Ein Schlüssel aus zwei Spalten heißt zusammengesetzter Schlüssel.",
    },
    "references": {
        kind: "Schlüsselwort",
        text: "references macht eine Spalte zum Fremdschlüssel: Sie verweist auf den Primärschlüssel einer anderen Tabelle.",
        simple: "create table reiseziel (\n  rid integer primary key,\n  lnr varchar(4) references land(lnr)\n);",
        advanced: "create table reise (\n  rid integer primary key,\n  von_onr varchar(6) references ort(onr),\n  nach_onr varchar(6) references ort(onr),\n  km integer\n);",
        note: "Zwei Fremdschlüssel auf dieselbe Tabelle: Start- und Zielort einer Reise.",
    },
    "integer": {
        kind: "Datentyp",
        text: "integer ist der Datentyp für ganze Zahlen (ohne Komma).",
        simple: "create table punkte (\n  pid integer primary key,\n  wert integer\n);",
        advanced: "create table zeugnisnote (\n  sid integer,\n  fach varchar(10),\n  note integer not null,\n  primary key (sid, fach)\n);",
        note: "not null: Das Feld darf nicht leer bleiben.",
    },
    "varchar": {
        kind: "Datentyp",
        text: "varchar(n) ist der Datentyp für Texte mit höchstens n Zeichen.",
        simple: "create table fach (\n  kuerzel varchar(3) primary key,\n  name varchar(30)\n);",
        advanced: "create table lehrkraft (\n  kuerzel varchar(4) primary key,\n  vorname varchar(20) not null,\n  nachname varchar(30) not null,\n  fach1 varchar(3) references fach(kuerzel)\n);",
    },
};

/** Hilfe zu einem Button-Text der Symbolleiste ("count(|)" → "count", "'|'" → "''") */
export function helpFor(label: string): { key: string, help: SymbolHelp } | null {
    let key = label.replace("|", "");
    if (!SYMBOL_HELP[key]) key = key.replace(/\(\)$/, "");
    const help = SYMBOL_HELP[key];
    return help ? { key, help } : null;
}
