// A small in-memory stand-in for the Apps Script globals Code.gs uses.
// Enough to run the backend in Node for tests and for the local dev server.
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

class Range {
  constructor(sheet, r, c, nr, nc) { Object.assign(this, { sheet, r, c, nr, nc }); }
  getValues() {
    const out = [];
    for (let i = 0; i < this.nr; i++) {
      const row = this.sheet.data[this.r - 1 + i] || [];
      out.push(Array.from({ length: this.nc }, (_, j) => row[this.c - 1 + j] ?? ''));
    }
    return out;
  }
  setValues(values) {
    if (values.length !== this.nr || values.some(v => v.length !== this.nc)) throw new Error('setValues: shape mismatch');
    for (let i = 0; i < this.nr; i++) {
      const idx = this.r - 1 + i;
      while (this.sheet.data.length <= idx) this.sheet.data.push([]);
      for (let j = 0; j < this.nc; j++) this.sheet.data[idx][this.c - 1 + j] = values[i][j];
    }
    return this;
  }
  clearContent() {
    for (let i = 0; i < this.nr; i++) {
      const row = this.sheet.data[this.r - 1 + i];
      if (row) for (let j = 0; j < this.nc; j++) row[this.c - 1 + j] = '';
    }
    return this;
  }
  setNumberFormat() { return this; }
  setFontWeight() { return this; }
}

class Sheet {
  constructor(name, sheets) { this.name = name; this.data = []; this.sheets = sheets; }
  setName(n) { this.sheets.delete(this.name); this.name = n; this.sheets.set(n, this); return this; }
  getName() { return this.name; }
  getLastRow() {
    let n = this.data.length;
    while (n > 0 && (this.data[n - 1] || []).every(v => v === '' || v === undefined || v === null)) n--;
    return n;
  }
  getLastColumn() { return Math.max(0, ...this.data.map(r => r.length)); }
  getMaxRows() { return Math.max(1000, this.data.length); }
  getMaxColumns() { return 26; }
  getRange(r, c, nr = 1, nc = 1) { return new Range(this, r, c, nr, nc); }
  setFrozenRows() { return this; }
}

export function createFakeGas({ now } = {}) {
  const sheets = new Map();
  const cache = new Map();
  const log = [];
  const clock = { now: now || (() => new Date()) };
  const ss = {
    getSheetByName: n => sheets.get(n) || null,
    insertSheet: n => { const s = new Sheet(n, sheets); sheets.set(n, s); return s; }
  };
  const pad = n => String(n).padStart(2, '0');
  const globals = {
    SpreadsheetApp: { getActiveSpreadsheet: () => ss },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    CacheService: { getScriptCache: () => ({ get: k => (cache.has(k) ? cache.get(k) : null), put: (k, v) => { cache.set(k, v); } }) },
    Utilities: {
      formatDate: (d, tz, fmt) => {
        const s = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
        return fmt.includes('HH') ? s : s.slice(0, 10);
      },
      getUuid: () => 'uuid-' + Math.random().toString(16).slice(2)
    },
    ContentService: { createTextOutput: s => ({ text: s, setMimeType() { return this; } }), MimeType: { JSON: 'json' } },
    Logger: { log: m => log.push(String(m)) },
    Date: class extends Date { constructor(...a) { super(...(a.length ? a : [clock.now()])); } },
    Math, JSON, String, Number, Array, Object, RegExp, Error
  };
  const ctx = vm.createContext(globals);
  const code = fs.readFileSync(path.join(here, '..', 'apps-script', 'Code.gs'), 'utf8');
  vm.runInContext(code, ctx, { filename: 'Code.gs' });
  return {
    ctx, sheets, cache, log, clock,
    setup: () => ctx.setup(),
    handle: body => JSON.parse(JSON.stringify(ctx.handleRequest(JSON.parse(JSON.stringify(body))))),  // round-trip like HTTP would
    rows: name => sheets.get(name).data.slice(1).filter(r => r.some(v => v !== '' && v !== undefined)),
    adminCode: () => sheets.get('Users').data[1][1]
  };
}
