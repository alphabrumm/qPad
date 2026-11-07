/* QPad-Erweiterung für den Lernpfad-Editor PathFinder.
 * Bausteine: SQL-Aufgabe (QPad prüft das Ergebnis gegen eine Musterabfrage), Datenbank laden.
 * Code-Bausteine mit SQL bekommen in QPad den Knopf „In QPad einfügen“ (host.copyCode).
 * Läuft PathFinder in QPad (Editor im Lernpfad-Bereich oder exportierter Lernpfad im Projekt), spricht
 * createBridgeHost() per postMessage mit QPad – siehe pad/README.md, „Lernpfad-Schnittstelle“. */
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* ---------- Ergebnisse vergleichen ---------- */
const cell = v => { if (v == null) return null; if (typeof v === 'number') return Math.round(v * 1e6) / 1e6; const n = Number(String(v).trim()); return String(v).trim() !== '' && !isNaN(n) ? Math.round(n * 1e6) / 1e6 : String(v).trim(); };
const rowKey = r => JSON.stringify(r.map(cell));
/** Zwei Abfrageergebnisse gleich? Spaltennamen zählen nicht (Aliasse), Reihenfolge nur wenn verlangt. */
export function sameResult(a, b, ordered = false) {
  if (!a || !b || a.error || b.error) return false;
  if ((a.columns || []).length !== (b.columns || []).length) return false;
  const A = (a.values || []).map(rowKey), B = (b.values || []).map(rowKey);
  if (A.length !== B.length) return false;
  if (ordered) return A.every((k, i) => k === B[i]);
  const cnt = new Map(); A.forEach(k => cnt.set(k, (cnt.get(k) || 0) + 1));
  return B.every(k => { const c = cnt.get(k); if (!c) return false; cnt.set(k, c - 1); return true; });
}
function why(mine, want) {
  if (mine.error) return mine.error;
  if ((mine.columns || []).length !== (want.columns || []).length) return `Deine Abfrage liefert ${mine.columns.length} Spalte${mine.columns.length === 1 ? '' : 'n'}, erwartet ${want.columns.length}.`;
  if ((mine.values || []).length !== (want.values || []).length) return `Deine Abfrage liefert ${mine.values.length} Zeile${mine.values.length === 1 ? '' : 'n'}, erwartet ${want.values.length}.`;
  return 'Die Zeilenzahl stimmt, aber die Werte (oder ihre Reihenfolge) noch nicht.';
}
function miniResult(r, max = 6) {
  if (!r || r.error) return '';
  const rows = (r.values || []).slice(0, max);
  return `<table class="qp-mini"><tr>${r.columns.map(c => `<th>${esc(c)}</th>`).join('')}</tr>${rows.map(v => `<tr>${v.map(x => `<td>${esc(x)}</td>`).join('')}</tr>`).join('')}</table>${r.values.length > max ? `<div class="qp-more">… insgesamt ${r.values.length} Zeilen</div>` : ''}`;
}

/* ---------- Brücke zu QPad ---------- */
export function makeBridge(target = window.parent) {
  const W = {}, L = [];
  addEventListener('message', e => {
    if (e.source !== target) return; const m = e.data; if (!m || typeof m !== 'object') return;
    if (m.req && W[m.req]) { const f = W[m.req]; delete W[m.req]; f(m); return; }
    if (m.type === 'qpad-executed') L.forEach(f => { try { f(m); } catch (x) { } });
  });
  const ask = (action, data = {}) => new Promise((ok, no) => {
    const req = 'r' + String(Math.random()).slice(2); const t = setTimeout(() => { delete W[req]; no(new Error('QPad antwortet nicht')); }, 5000);
    W[req] = m => { clearTimeout(t); ok(m); }; target.postMessage({ type: 'qpad', action, req, ...data }, '*');
  });
  return { send: (action, data = {}) => target.postMessage({ type: 'qpad', action, ...data }, '*'), post: m => target.postMessage(m, '*'), ask, onExecuted: f => L.push(f) };
}
export function createBridgeHost(bridge, { editor = false } = {}) {
  bridge = bridge || makeBridge();
  let api = null, last = null;
  const checkAll = async (mine) => {
    if (!api || mine.error) return;
    const open = api.doc.stations.flatMap(s => s.blocks).filter(b => b.type === 'sqltask' && b.query && !api.prog.solved[b.id]);
    for (const b of open) {
      const want = await bridge.ask('query', { sql: b.query }).catch(() => null);
      if (want && !want.error && sameResult(mine, want, !!b.ordered)) {
        if (api.mode === 'preview') api.solve(b.id); else api.toast(`✓ QPad: Ergebnis passt zu „${esc(b.title)}“ (in der Vorschau zählt es)`);
        return;
      }
    }
  };
  bridge.onExecuted(m => { last = m; checkAll(m); });
  const host = {
    name: 'QPad', copyLabel: 'In QPad einfügen',
    attach(a) { api = a; },
    reset() { },
    copyCode(b) { bridge.send('insert', { sql: b.code || '' }); },
    insert(sql) { bridge.send('insert', { sql }); },
    vorlage(name) { bridge.send('vorlage', { name }); },
    query: sql => bridge.ask('query', { sql }),
    script: () => bridge.ask('script'),
    lastExecuted: () => last,
  };
  if (editor) host.adopt = async (html, title) => bridge.post({ type: 'qpad-set-lernpfad', html, title });
  return host;
}

/* ---------- Bausteine ---------- */
let vorlagen = null;
const loadVorlagen = async () => vorlagen || (vorlagen = await fetch(new URL('../vorlagen/vorlagen.json', location.href)).then(r => r.json()).catch(() => []));

export const qpadPlugin = {
  id: 'qpad', name: 'QPad',
  get bundle() {
    try {
      if (!/^https?:/.test(import.meta.url)) return null;
      return { icon: '🗄', entry: 'plugin', exportName: 'qpadPlugin', hostExport: 'createBridgeHost',
        // Handschlag: Antwortet QPad, läuft der Lernpfad in QPad
        inside: `new Promise(r => { if (parent === window) return r(false); const t = setTimeout(() => r(false), 700); addEventListener('message', e => { if (e.data && e.data.type === 'qpad-hello') { clearTimeout(t); r(true); } }); parent.postMessage({ type: 'qpad', action: 'hello' }, '*'); })`,
        modules: [{ name: 'plugin', url: import.meta.url }] };
    } catch (e) { return null; }
  },
  blocks: {
    sqltask: {
      n: 'SQL-Aufgabe', ic: '🗄', g: 'QPad', h: 'QPad prüft das Ergebnis gegen eine Musterabfrage', openForm: true,
      make: () => ({ title: '', html: '', query: '', start: '', ordered: false, xp: 20, tips: [], solution: '', img: '' }),
      check: () => true,
      label: b => b.title || 'die SQL-Aufgabe',
      render(b, x) {
        const ok = x.prog.solved[b.id], fb = x.prog.quiz[b.id];
        const buttons = (b.start ? `<button class="lp-btn alt" data-run="start">⤵ Anfang in QPad einfügen</button>` : '')
          + (!x.E() && !ok ? `<button class="lp-btn alt" data-run="checklast">✓ Letzte Abfrage prüfen</button>` : '');
        const hint = b.query ? `QPad prüft automatisch, sobald eine Abfrage dasselbe Ergebnis liefert wie <code>${esc(b.query.length > 70 ? b.query.slice(0, 70) + '…' : b.query)}</code>${b.ordered ? ' (Reihenfolge zählt)' : ''}.` : '⚙ → Musterabfrage eintragen';
        let h = x.taskCard(b, { buttons, hint, where: '🗄 QPad' });
        if (fb && !ok && !x.E()) h = h.replace(/<\/div>$/, `<div class="fb qp-fb">✗ ${esc(fb.msg)}</div></div>`);
        return h;
      },
      exportAs: b => ({ type: 'task', id: b.id, title: b.title, html: `${b.html || ''}${b.start ? `<pre class="qp-start">${esc(b.start)}</pre>` : ''}<i>Bearbeite die Aufgabe in einer SQL-Umgebung und hake danach ab.</i>`, xp: b.xp ?? 20, tips: b.tips || [], tipsHide: b.tipsHide, solution: b.solution || (b.query ? `<pre>${esc(b.query)}</pre>` : ''), solHide: b.solHide, img: b.img || '' }),
      form: [
        { k: 'title', l: 'Titel', t: 'text' },
        { k: 'query', l: 'Musterabfrage (SELECT) – QPad vergleicht das Ergebnis', t: 'qp-sql', take: 'statement' },
        { k: 'ordered', l: 'Reihenfolge der Zeilen muss stimmen (z. B. bei ORDER BY)', t: 'check' },
        { k: 'start', l: 'Anfang zum Einfügen (optional, z. B. SELECT … FROM …)', t: 'qp-sql' },
        { k: 'tips', l: 'Tipps (werden nacheinander aufgedeckt)', t: 'list', ph: 'Tipp', vis: 'tipsHide' },
        { k: 'solution', l: 'Lösung zum Aufdecken (leer = Musterabfrage)', t: 'text' },
        { k: 'solHide', l: 'Lösung für Schüler sichtbar', t: 'shown' },
        { k: 'img', l: 'Bild oder GIF zur Aufgabe', t: 'image' },
        { k: 'xp', l: 'XP', t: 'number' },
      ],
      async run(a, b, x) {
        const h = x.host;
        if (a === 'start') { if (h.insert) h.insert(b.start); else navigator.clipboard?.writeText(b.start).then(() => x.toast('⧉ kopiert')); return; }
        if (a === 'checklast') {
          if (!h.query) { x.toast('Prüfen geht nur in QPad.'); return; }
          let mine = h.lastExecuted?.();
          if (!mine) { const s = await h.script().catch(() => null); if (s?.statement) mine = await h.query(s.statement).catch(() => null); }
          if (!mine) { x.prog.quiz[b.id] = { msg: 'Führe deine Abfrage zuerst in QPad aus (▶).' }; x.render(); return; }
          const want = await h.query(b.query).catch(e => ({ error: e.message }));
          if (want.error) { x.toast('Musterabfrage: ' + esc(want.error)); return; }
          if (sameResult(mine, want, !!b.ordered)) x.solve(b.id); else { x.prog.quiz[b.id] = { msg: why(mine, want) }; x.prog.tries[b.id] = (x.prog.tries[b.id] || 0) + 1; x.render(); }
        }
      },
    },
    dbload: {
      n: 'Datenbank laden', ic: '🛢', g: 'QPad', h: 'Knopf, der eine Vorlage-Datenbank in QPad lädt', openForm: true,
      make: () => ({ label: 'Datenbank laden', name: 'pausenkiosk.sqLite', html: '' }),
      render(b, x) {
        return `<div class="lp-card qp-db"><b class="lp-ctitle">🛢 ${esc(b.label || 'Datenbank laden')}</b>${b.html ? `<div>${b.html}</div>` : ''}<div><button class="lp-btn" data-run="load">🛢 „${esc(b.name)}“ in QPad laden</button></div>${x.E() ? '<div class="ed-hint">Ersetzt die Datenbank des Projekts (QPad fragt vorher nach).</div>' : ''}</div>`;
      },
      exportAs: b => ({ type: 'info', id: b.id, kind: 'tipp', title: b.label || 'Datenbank', html: `${b.html || ''} Diese Aufgaben brauchen die Datenbank <b>${esc(b.name)}</b> in QPad.`, img: '', name: '' }),
      form: [{ k: 'label', l: 'Überschrift', t: 'text' }, { k: 'name', l: 'Datenbank (Vorlage aus QPad)', t: 'qp-vorlage' }, { k: 'html', l: 'Text dazu (optional)', t: 'text' }],
      run(a, b, x) { if (a === 'load') { if (x.host.vorlage) x.host.vorlage(b.name); else x.toast('Geht nur in QPad.'); } },
    },
  },
  fields: {
    'qp-sql': {
      html(f, v, b, x) {
        const take = x.host.script ? `<button class="take" data-qptake="${f.k}">⤵ Anweisung aus QPad übernehmen</button><button class="take" data-qptry="${f.k}">▶ Ergebnis ansehen</button>` : '';
        return `<label>${esc(f.l)}<textarea class="mono" data-k="${f.k}" rows="4" spellcheck="false" autocapitalize="off">${esc(v || '')}</textarea></label><div class="row">${take}</div><div class="qp-try" data-qpres="${f.k}"></div>`;
      },
      async click(d, b, draw, x) {
        if (d.qptake) {
          const s = await x.host.script?.().catch(() => null);
          if (!s?.statement) { x.toast('In QPad zuerst den Cursor in eine Anweisung setzen.'); return; }
          b[d.qptake] = s.statement; draw(); x.toast('Anweisung übernommen');
        }
        if (d.qptry) {
          const r = await x.host.query?.(b[d.qptry] || '').catch(e => ({ error: e.message }));
          const el = document.querySelector(`[data-qpres="${d.qptry}"]`); if (el) el.innerHTML = r?.error ? `<span style="color:#c0392b">${esc(r.error)}</span>` : miniResult(r);
        }
      },
    },
    'qp-vorlage': {
      html(f, v, b) {
        const id = 'qpv' + Math.random().toString(36).slice(2, 7);
        loadVorlagen().then(list => { const s = document.getElementById(id); if (s && list.length) s.innerHTML = list.map(t => `<option value="${esc(t.file)}"${t.file === v ? ' selected' : ''}>${esc(t.name)} – ${esc(t.file)}</option>`).join('') + (list.some(t => t.file === v) ? '' : `<option value="${esc(v)}" selected>${esc(v)}</option>`); });
        return `<label>${esc(f.l)}<select data-k="${f.k}" id="${id}"><option value="${esc(v)}">${esc(v)}</option></select></label>`;
      },
    },
  },
  // Textformat („Vorlage für KI“)
  text: {
    'sql-aufgabe': {
      n: 'SQL-Aufgabe', type: 'sqltask', alias: ['sqlaufgabe', 'sql'], keys: ['abfrage', 'muster', 'start', 'reihenfolge', 'tipp', 'loesung', 'xp', 'punkte'],
      help: `### SQL-Aufgabe: Titel
Arbeitsauftrag, z. B. „Gib Name und Preis aller Produkte unter 1 € aus.“
Abfrage: SELECT name, preis FROM Produkt WHERE preis < 1     (Musterabfrage in EINER Zeile – QPad vergleicht das Ergebnis)
Start: SELECT … FROM Produkt                                 (optional: Anfang zum Einfügen)
Reihenfolge: ja                                              (nur wenn ORDER BY verlangt ist)
Tipp: …
XP: 20
(Die Musterabfrage muss zur Datenbank passen – nur Tabellen und Spalten verwenden, die es dort gibt.)

### Datenbank: pausenkiosk.sqLite
Text zum Knopf, der die Datenbank in QPad lädt.`,
      make(S, H) {
        const q = (S.one('abfrage') || S.one('muster') || '').replace(/^`|`$/g, '').trim();
        if (!/^\s*(select|with)\b/i.test(q)) H.err(S.line, `SQL-Aufgabe „${S.title}“: „Abfrage: SELECT …“ fehlt.`);
        return { type: 'sqltask', title: S.title, html: H.md(S.body), query: q, start: (S.one('start') || '').replace(/^`|`$/g, ''), ordered: /^(ja|yes|true)/i.test(S.one('reihenfolge') || ''), xp: S.num('xp', 20),
          tips: S.all('tipp').map(H.inline || (t => t)), ...(S.hid?.('tipp').some(Boolean) ? { tipsHide: S.hid('tipp') } : {}), solution: S.one('loesung') ? (H.inline || (t => t))(S.one('loesung')) : '', ...(S.hid?.('loesung')[0] ? { solHide: true } : {}), img: '' };
      },
      toText(b, { md }) {
        return [`### SQL-Aufgabe: ${md(b.title || '')}`, md(b.html || ''), `Abfrage: ${String(b.query || '').replace(/\s+/g, ' ')}`, b.start ? `Start: ${String(b.start).replace(/\s+/g, ' ')}` : '', b.ordered ? 'Reihenfolge: ja' : '',
          ...(b.tips || []).map((t, i) => `Tipp${b.tipsHide?.[i] ? ' (verborgen)' : ''}: ${md(t)}`), b.solution ? `Lösung${b.solHide ? ' (verborgen)' : ''}: ${md(b.solution).replace(/\n+/g, ' ')}` : '', `XP: ${b.xp ?? 20}`].filter(Boolean).join('\n');
      },
    },
    datenbank: {
      n: 'Datenbank', type: 'dbload', alias: ['datenbank laden'], keys: [],
      make: (S, H) => ({ type: 'dbload', label: 'Datenbank laden', name: S.title.trim() || 'pausenkiosk.sqLite', html: H.md(S.body) }),
      toText: (b, { md }) => [`### Datenbank: ${b.name}`, md(b.html || '')].filter(Boolean).join('\n'),
    },
  },
  css: `
.qp-mini { font: 12px/1.3 ui-monospace, Menlo, monospace; border-collapse: collapse; margin: 6px 0; display: block; overflow-x: auto; }
.qp-mini td, .qp-mini th { border: 1px solid var(--line, #ddd); padding: 2px 6px; white-space: nowrap; }
.qp-mini th { background: var(--surface-2, #f3f3f3); }
.qp-more { font-size: 12px; opacity: .7; }
.qp-fb { color: var(--bad, #c0392b); font-weight: 700; margin-top: 6px; }
.qp-start { font: 13px/1.4 ui-monospace, Menlo, monospace; background: var(--surface-2, #f3f3f3); padding: 8px; border-radius: 8px; white-space: pre-wrap; }
.qp-db .lp-btn { margin-top: 6px; }
`,
};
