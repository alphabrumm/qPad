# QPad – SQL-IDE für iPad

QPad ist die touch-taugliche Variante der [SQL-IDE](https://github.com/martin-pabst/SQL-IDE) von Martin Pabst.
Alles läuft lokal im Browser – **kein Login, keine Serverlogik, keine Datenbank auf dem Server**.

## Was ist anders als im Original?

| | Original (sql-ide.de) | QPad |
|---|---|---|
| Editor | Monaco (nicht für Touch gebaut) | CodeMirror 6, native iOS-Textauswahl, keine Autokorrektur |
| Eingabe | Tastatur | zusätzliche Symbolleiste (`; , ( ) * = < > ' %` und SQL-Schlüsselwörter) |
| Speichern | Server mit Login | automatisch lokal (IndexedDB) + **Projektdatei herunterladen** |
| Compiler, Fehlermeldungen, Vervollständigung | ✓ | ✓ – unveränderter Code aus `src/client/compiler` |
| MySQL-Dump-Import | ✓ | ✓ (.sql, .zip, .sqlite) |
| Server | PHP/Java-Backend + Datenbank | **nur statischer Webserver** |

## Ablauf im Unterricht

1. Schüler/innen öffnen die Seite im Safari (optional: *Teilen → Zum Home-Bildschirm*).
2. **Datenbank → Vorlage laden** oder eine Projektdatei der Lehrkraft öffnen.
3. SQL schreiben, **▶ Ausführen** (führt die grün markierte Anweisung aus) oder **Alle**.
4. Am Ende der Stunde **⬇ Herunterladen** → Datei `Name.sqlprojekt.json` landet in *Dateien → Downloads*
   (oder *Projekt → Teilen …* direkt nach Teams/AirDrop/OneDrive).
5. Nächste Stunde: **☰ → Projekt öffnen → Projektdatei öffnen**.

Zwischendurch wird alles automatisch im Browser gesichert; ein versehentliches Neuladen verliert nichts.
**Rückgängig** gibt es für den Text (↶ ↷) und für Datenänderungen (*↶ Daten*, *Datenbank zurücksetzen*).

### Für Lehrkräfte
* Aufgabenblätter als Projekt vorbereiten (Datenbank + Skript mit Aufgaben), herunterladen, an die Klasse verteilen.
* Direktlinks: `https://server/sql/?vorlage=chinook.sqLite` oder `https://server/sql/?projekt=aufgaben/blatt3.sqlprojekt.json`
  (Datei liegt dann im selben Webordner).
* Eigene Vorlagen: Datei in `vorlagen/` legen und in `vorlagen/vorlagen.json` eintragen
  (`.sqlite`, MySQL-`.sql` oder `.zip`).

## Server-Anforderungen

Nur ein **HTTP(S)-Server, der statische Dateien ausliefert**. Kein SQL-Server, kein PHP, keine Datenbank.

* **HTTPS** empfohlen: nur dann funktionieren Offline-Modus (Service Worker) und „Zum Home-Bildschirm" zuverlässig.
* MIME-Typ für `.wasm` muss `application/wasm` sein (bei aktuellen nginx-Versionen Standard, bei Apache ggf. ergänzen).
* Gesamtgröße: ca. 1,2 MB App + 4,5 MB Beispieldatenbanken.

Apache (`.htaccess`, falls nötig):
```
AddType application/wasm .wasm
AddType application/manifest+json .webmanifest
```
nginx (`mime.types`): `application/wasm wasm;`

## Bauen

```
./setup-deps.sh          # holt CodeMirror/Lezer-Quellen (git) und sql.js (GitHub-Release) nach ../../deps
node build.mjs           # erzeugt dist/ (benötigt esbuild; Pfad per ESBUILD=… anpassbar)
```
`dist/` komplett auf den Webserver kopieren – fertig.

## Dateien

* `src/main.ts` – Oberfläche, Ausführen, Projekte, Dialoge
* `src/editor.ts` – CodeMirror-Editor, Fehleranzeige, Semikolon-Engel
* `src/compile.ts`, `src/module.ts` – Anbindung des Original-Compilers ohne Monaco
* `src/completion.ts` – Code-Vervollständigung (Portierung von `MyCompletionItemProvider`)
* `src/db.ts`, `src/worker.ts`, `src/sqlFunctions.ts` – SQLite im Web-Worker
* `src/importers.ts` – Projektdateien, SQLite-, MySQL- und ZIP-Import
* `src/project.ts` – Projektformat und lokale Speicherung

Hinweis: Safari löscht Website-Daten, die 7 Tage nicht benutzt wurden. Deshalb ist der Download am Stundenende der eigentliche Speicherort.
