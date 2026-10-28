// Build der iPad-Variante der SQL-IDE.
// Aufruf:  node build.mjs [zielordner]      (Standard: dist)
// Benötigt nur esbuild sowie die Quellen von CodeMirror/Lezer und die sql.js-Release-Dateien (siehe README.md).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const esbuildPath = process.env.ESBUILD || '/opt/npm-tools/node_modules/esbuild/lib/main.js';
const esbuild = await import(esbuildPath);
const DEPS = process.env.PAD_DEPS || path.join(here, '..', '..', 'deps');
const out = path.resolve(process.argv[2] || path.join(here, 'dist'));

// Paketname -> Quelldatei (CodeMirror 6 / Lezer werden direkt aus den TypeScript-Quellen gebündelt)
const map = {
  '@codemirror/state': 'state/src/index.ts',
  '@codemirror/view': 'view/src/index.ts',
  '@codemirror/language': 'language/src/index.ts',
  '@codemirror/commands': 'commands/src/commands.ts',
  '@codemirror/autocomplete': 'autocomplete/src/index.ts',
  '@codemirror/lint': 'lint/src/lint.ts',
  '@codemirror/search': 'search/src/search.ts',
  '@lezer/common': 'common/src/index.ts',
  '@lezer/highlight': 'highlight/src/highlight.ts',
  '@lezer/lr': 'lr/src/index.ts',
  '@marijn/find-cluster-break': 'find-cluster-break/src/index.js',
  'style-mod': 'style-mod/src/style-mod.js',
  'w3c-keyname': 'w3c-keyname/index.js',
  'crelt': 'crelt/index.js',
};
const vendorPlugin = {
  name: 'vendor',
  setup(build) {
    build.onResolve({ filter: /^[@a-z]/ }, args => {
      if (map[args.path]) return { path: path.join(DEPS, map[args.path]) };
      // Der SQL-IDE-Compiler importiert Monaco nur für Typen -> leeres Modul
      if (args.path === 'monaco-editor') return { path: path.join(here, 'src/monaco-shim.ts') };
      return undefined;
    });
  }
};

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

const common = {
  bundle: true, target: ['safari15'], minify: process.env.DEV !== '1', sourcemap: process.env.DEV === '1',
  plugins: [vendorPlugin], logLevel: 'warning', legalComments: 'none',
};
await esbuild.build({ ...common, entryPoints: [path.join(here, 'src/main.ts')], format: 'esm', outfile: path.join(out, 'app.js') });
await esbuild.build({ ...common, entryPoints: [path.join(here, 'src/worker.ts')], format: 'iife', outfile: path.join(out, 'worker.js') });

// statische Dateien
const copyDir = (from, to) => {
  fs.mkdirSync(to, { recursive: true });
  for (const f of fs.readdirSync(from)) {
    const s = path.join(from, f), d = path.join(to, f);
    if (fs.statSync(s).isDirectory()) copyDir(s, d); else fs.copyFileSync(s, d);
  }
};
copyDir(path.join(here, 'public'), out);
for (const f of ['sql-wasm.js', 'sql-wasm.wasm']) fs.copyFileSync(path.join(DEPS, 'sqljs', f), path.join(out, f));

// Vorlagen: Beispieldatenbanken der SQL-IDE
const vorlagen = path.join(out, 'vorlagen');
fs.mkdirSync(vorlagen, { recursive: true });
const dbDir = path.join(here, '..', 'public', 'assets', 'databases');
const known = {
  'pausenkiosk.sqLite': ['Pausenkiosk', 'Schüler/innen, Snacks und Einkäufe am Schulkiosk (Demo-Lernpfad)'],
  'chinook.sqLite': ['Chinook (Musikshop)', 'Künstler, Alben, Titel, Kunden, Rechnungen'],
  'terra.sqLite': ['Terra (Geographie)', 'Länder, Städte, Flüsse, Berge'],
  'world1.sqLite': ['World', 'Länder, Städte und Sprachen der Welt'],
  'schule1.sqLite': ['Schule', 'Schüler, Klassen, Lehrkräfte, Fächer'],
  'benutzer_buch.sqLite': ['Benutzer und Bücher', 'kleine Bibliotheksdatenbank'],
};
const list = [];
for (const f of fs.readdirSync(dbDir)) {
  if (!known[f]) continue;
  fs.copyFileSync(path.join(dbDir, f), path.join(vorlagen, f));
  list.push({ name: known[f][0], description: known[f][1], file: f });
}
// Reihenfolge wie in „known“ (Pausenkiosk zuerst)
list.sort((a, b) => Object.keys(known).indexOf(a.file) - Object.keys(known).indexOf(b.file));
fs.writeFileSync(path.join(vorlagen, 'vorlagen.json'), JSON.stringify(list, null, 2));

// Service Worker (Offline-Fähigkeit, nur über HTTPS aktiv)
const shell = ['./', 'index.html', 'style.css', 'app.js', 'worker.js', 'sql-wasm.js', 'sql-wasm.wasm', 'manifest.webmanifest', 'icon.svg', 'icon-180.png', 'icon-512.png',
  // Demo-Lernpfad samt Datenbank: auch beim allerersten Start offline verfügbar
  'learn/demo/Lernpfad-Pausenkiosk.html', 'vorlagen/pausenkiosk.sqLite',
  ...['grass', 'dirt', 'stonebricks', 'deepslatebricks', 'planks', 'darkplanks'].map(t => `tiles/${t}.png`)];
const hash = crypto.createHash('sha1');
for (const f of shell.slice(1)) if (fs.existsSync(path.join(out, f))) hash.update(fs.readFileSync(path.join(out, f)));
const version = hash.digest('hex').substring(0, 10);
fs.writeFileSync(path.join(out, 'sw.js'), fs.readFileSync(path.join(here, 'src/sw.template.js'), 'utf8')
  .replace('__VERSION__', version).replace('__SHELL__', JSON.stringify(shell)));

console.log(`Fertig: ${out} (Version ${version})`);
