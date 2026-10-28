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

## Layout (wie JPad)

* **Quer** (iPad quer, Laptop – ab 900 px und breiter als hoch): Tabellen | Editor mit Ergebnis | Lernpfad nebeneinander.
  Der Lernpfad hat zwei Breiten (38 % / 50 %) und „volle Breite“; der Knopf im Editor-Kopf blendet ihn aus und wieder ein.
  Projekte mit Lernpfad starten mit zugeklappten Tabellen und breitem Lernpfad.
* **Hochkant** (iPad hoch, Handy): eine Ansicht, unten die Reiter **Lernpfad · Code · Tabellen**.
  Wechselt man bei offener Bildschirmtastatur zu Lernpfad oder Tabellen, bleibt die Tastatur offen (der Editor wird „geparkt“).
  Ein Tipp auf einen Spaltennamen oder „Inhalt“ springt zurück zum Code.
* **Hinweis „Dreh dein iPad hochkant“**: geht im Querformat die Bildschirmtastatur auf, einmal pro Sitzung (abschaltbar für 4 Wochen).

## Themes (wie JPad)

☰ → Darstellung, unter Hell/Dunkel/System: **Standard, Kiosk** (Farbwelt des Demo-Lernpfads „Der Pausenkiosk“),
**Hund, Schaf** (Farbwelten der JPad-Lernpfade), **Flach** (Weiß/Blau, dunkel Navy), **Hacker** (Neon-Grün) und **Pink**.
Alle folgen Hell/Dunkel/System; Flach/Hacker/Pink mit spitzen Ecken, feinen Linien und Chakra Petch/Share Tech Mono
(Google Fonts, offline Ersatzschriften). Gemerkt in `qpad.skin`, gesetzt vor dem ersten Zeichnen (kein Aufblitzen).

## Lernpfade

* Ein Lernpfad ist eine HTML-Seite, die im Projekt mitreist (Feld `lernpfadHtml` der Projektdatei, Bilder als data-URIs).
  Er läuft in einem abgeschotteten iframe; sein localStorage (z. B. Häkchen) wird per postMessage je Projekt gemerkt.
* **☰ → Lernpfad einbetten**: HTML-Datei oder ZIP (index.html mit Unterordnern wie `img/`). **Lernpfad entfernen** ebenso im Menü.
* **Per Link**: `…/?lernpfad=<Adresse>` – HTML, ZIP oder Projektdatei (`.sqlprojekt.json` mit eingebettetem Lernpfad).
  Kombinierbar mit `&projekt=<Projektdatei>` oder `&vorlage=<Datenbank>`, `&neu` erzwingt eine frische Kopie.
  Beim ersten Aufruf entsteht ein neues Projekt, derselbe Link öffnet danach dieses Projekt mit dem Stand des Schülers.
* Ein Lernpfad kann seine Datenbank selbst nennen: `<meta name="qpad-vorlage" content="pausenkiosk.sqLite">`
  (Dateiname aus `vorlagen/` oder Adresse relativ zum Lernpfad). Sie wird beim Öffnen per Link geladen bzw. beim Einbetten angeboten.
* **„In QPad einfügen“**: Knöpfe im Lernpfad schicken `parent.postMessage({ type: "qpad-insert", sql: "…" }, "*")`;
  QPad hängt die Anweisung ans Ende des geöffneten Skripts und setzt den Cursor hinein (hochkant: Wechsel zum Code).
* **Demo** (`learn/demo/Lernpfad-Pausenkiosk.html`, auch als ZIP): „Der Pausenkiosk“ mit der Vorlage
  `pausenkiosk.sqLite` (Schüler/innen der 9. Klassen, Produkte, Einkäufe). Öffnet sich beim allerersten Start,
  später über **☰ → Demo laden**. Quelle der Datenbank: `vorlagen-quellen/pausenkiosk.sql`
  (erzeugt mit `erzeuge_pausenkiosk.py`, in QPad importiert und als .sqlite exportiert).

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
* `src/lernpfad.ts` – Lernpfade aus HTML, ZIP oder Link laden, Bilder einbetten, localStorage-Ersatz im iframe
* `public/learn/demo/` – Demo-Lernpfad „Der Pausenkiosk“ mit Bildern

Hinweis: Safari löscht Website-Daten, die 7 Tage nicht benutzt wurden. Deshalb ist der Download am Stundenende der eigentliche Speicherort.
