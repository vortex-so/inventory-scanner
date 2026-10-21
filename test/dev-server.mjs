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

// A stand-in for opening the Google Sheet: the four tabs the script writes to, refreshed every two seconds.
const SHEET_PAGE = `<!doctype html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sheet (dev)</title>
<style>body{margin:0;font:13px/1.4 -apple-system,Segoe UI,Roboto,sans-serif;background:#f8f9fa;color:#202124}header{position:sticky;top:0;background:#fff;border-bottom:1px solid #dadce0;padding:10px 16px;display:flex;gap:16px;align-items:center}
header b{font-size:15px}header span{color:#5f6368}nav button{border:0;background:none;padding:8px 12px;font:inherit;cursor:pointer;border-bottom:2px solid transparent}nav button.on{border-color:#188038;font-weight:600;color:#188038}
main{padding:12px 16px;overflow:auto}table{border-collapse:collapse;background:#fff}th,td{border:1px solid #dadce0;padding:4px 8px;white-space:nowrap;font-size:12.5px;text-align:left}th{background:#f1f3f4;position:sticky;top:0}
td:first-child,th:first-child{background:#f1f3f4;color:#5f6368;text-align:right}tr.new td{background:#e6f4ea}</style></head><body>
<header><b>Inventaris (dev sheet)</b><span id="meta">memuat…</span><nav id="tabs"></nav></header><main id="main"></main>
<script>
let tab='Transactions', seen={};
async function load(){const d=await (await fetch('/sheet.json')).json();const names=Object.keys(d);
document.getElementById('tabs').innerHTML=names.map(n=>'<button class="'+(n===tab?'on':'')+'" onclick="tab=\''+n+'\';load()">'+n+' ('+Math.max(0,d[n].length-1)+')</button>').join('');
const rows=d[tab]||[];const head=rows[0]||[];const body=rows.slice(1);const key=r=>tab+'|'+r.join('\u0001');const first=!(tab in seen);seen[tab]=seen[tab]||new Set();
document.getElementById('main').innerHTML='<table><thead><tr><th></th>'+head.map(h=>'<th>'+h+'</th>').join('')+'</tr></thead><tbody>'+body.map((r,i)=>'<tr class="'+(!first&&!seen[tab].has(key(r))?'new':'')+'"><td>'+(i+2)+'</td>'+head.map((_,c)=>'<td>'+(r[c]??'')+'</td>').join('')+'</tr>').join('')+'</tbody></table>';
body.forEach(r=>seen[tab].add(key(r)));document.getElementById('meta').textContent='diperbarui '+new Date().toLocaleTimeString('id-ID')+' · baris baru berwarna hijau';}
load();setInterval(load,2000);
</script></body></html>`;

const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };

http.createServer((req, res) => {
  // Same CORS answer Apps Script gives a simple POST, so one dev server can be another one's "trial" unit.
  if (req.url === '/api' && req.method === 'OPTIONS') { res.writeHead(204, { 'access-control-allow-origin': '*' }); res.end(); return; }
  if (req.method === 'POST' && req.url === '/api') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      let out;
      try { out = gas.handle(JSON.parse(body || '{}')); } catch (e) { out = { ok: false, error: String(e) }; }
      res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
      res.end(JSON.stringify(out));
    });
    return;
  }
  let url = decodeURIComponent(req.url.split('?')[0]);
  if (url === '/') url = '/index.html';
  if (url === '/config.js') {
    // The local backend, plus any real Apps Script passed as TRIAL_API=https://script.google.com/.../exec
    const units = [{ key: 'dev', name: 'Lokal (memori)', apiUrl: '/api' }];
    if (process.env.TRIAL_API) units.push({ key: 'trial', name: process.env.TRIAL_NAME || 'Percobaan (Google Sheet)', apiUrl: process.env.TRIAL_API });
    res.writeHead(200, { 'content-type': types['.js'] });
    res.end(`window.APP_CONFIG = ${JSON.stringify({ appName: 'Inventory Scanner (dev)', units })};`);
    return;
  }
  if (url === '/sheet.json') {
    const out = {};
    for (const [name, sheet] of gas.sheets) out[name] = sheet.data.filter(r => r.some(v => v !== '' && v !== undefined));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(out));
    return;
  }
  if (url === '/sheet') {
    res.writeHead(200, { 'content-type': types['.html'] });
    res.end(SHEET_PAGE);
    return;
  }
  const file = path.join(root, url);
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}).listen(port, () => {
  console.log(`dev server on http://localhost:${port}  login: admin / ${admin}   or Fajar / 1234`);
  console.log(`the in-memory sheet, live: http://localhost:${port}/sheet` + (process.env.TRIAL_API ? `   trial backend: ${process.env.TRIAL_API}` : ''));
});
