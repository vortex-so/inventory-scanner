// Local dev server: serves the front end and runs the real Code.gs against an in-memory sheet.
//   node test/dev-server.mjs [port]      then open http://localhost:8787  (user: admin, code printed below)
// Nothing here is needed in production; the front end talks to the Apps Script URL in config.js.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFakeGas } from './fake-gas.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.argv[2] || 8787);
const gas = createFakeGas();
gas.setup();
const admin = gas.adminCode();
gas.sheets.get('Users').getRange(3, 1, 1, 4).setValues([['Fajar', '1234', 'operator', 'TRUE']]);

if (process.env.SEED !== '0') {
  const ids = n => Array.from({ length: n }, (_, i) => `1-MVG-12-25-NY-MD.${String(i + 1).padStart(3, '0')}`);
  const call = (action, payload) => gas.handle({ user: 'admin', code: admin, action, payload });
  call('item.import', { type: 'MODUL', name: 'Modul LED P2.9', category: 'LED Screen', ids: ids(40) });
  call('item.import', { type: 'POWER SUPPLY', name: 'PSU 200W', category: 'LED Screen', ids: Array.from({ length: 6 }, (_, i) => `1-MVG-12-25-NY-PSU.00${i + 1}`) });
  call('item.import', { type: 'BOX', name: 'Flight case', category: 'LED Screen', ids: ['2-MVG-12-25-NY-BX.001', '2-MVG-12-25-NY-BX.002'] });
  call('container.save', { containerType: 'BOX', cabinetId: '2-MVG-12-25-NY-BX.001', name: 'Box 1', note: '4 x 4 modul', createNew: true });
  call('container.save', { containerType: 'KABINET', name: 'Kabinet LED Utama', createNew: true });
  call('container.assign', { cabinetId: '2-MVG-12-25-NY-BX.001', ids: ids(16) });
  call('commit', { action: 'INSPEKSI', ids: ids(20), condition: 'BAIK' });
  call('commit', { action: 'INSPEKSI', ids: ids(22).slice(20), condition: 'RUSAK', damageNote: 'pixel mati' });
  call('commit', { action: 'KELUAR', ids: ids(8), eventDate: '2026-10-18', location: 'Ballroom Hotel ABC', eventName: 'Wisuda' });
}

const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };

http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/api') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      let out;
      try { out = gas.handle(JSON.parse(body || '{}')); } catch (e) { out = { ok: false, error: String(e) }; }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out));
    });
    return;
  }
  let url = decodeURIComponent(req.url.split('?')[0]);
  if (url === '/') url = '/index.html';
  if (url === '/config.js') {
    res.writeHead(200, { 'content-type': types['.js'] });
    res.end(`window.APP_CONFIG = { apiUrl: '/api', appName: 'Inventory Scanner (dev)' };`);
    return;
  }
  const file = path.join(root, url);
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}).listen(port, () => {
  console.log(`dev server on http://localhost:${port}  login: admin / ${admin}   or Fajar / 1234`);
});
