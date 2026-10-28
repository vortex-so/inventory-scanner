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
  // Media equipment as in Bagas's format: 24 units, two storage units, a few checks and one check-out.
  const call = (action, payload) => gas.handle({ user: 'admin', code: admin, action, payload });
  const add = p => call('item.add', p).data.addedIds;
  const bodies = ['SN0001001', 'SN0001002', 'SN0001003'].map(serial => add({ category: 'Kamera', subcategory: 'SONY Camera', brand: 'Sony', model: 'A7 III', serial })[0]);
  const lenses = ['5551', '5552'].map(serial => add({ category: 'Lensa', subcategory: 'E Mount', brand: 'Sony', model: 'FE 24-70mm GM', serial })[0]);
  const lights = add({ category: 'Lighting', subcategory: 'Godox', brand: 'Godox', model: 'SL60W', quantity: 2 });
  const cables = add({ category: 'Camera Support & Accessories', subcategory: 'Cable / Kabel', brand: 'Ugreen', model: 'HDMI 2m', quantity: 6 });
  const batteries = add({ category: 'Camera Support & Accessories', subcategory: 'Battery & Charger', brand: 'Sony', model: 'NP-FZ100', quantity: 8, location: 'Drybox' });
  const tripods = add({ category: 'Camera Support & Accessories', subcategory: 'Tripod & Monopod', brand: 'Manfrotto', model: '190X', quantity: 2 });
  add({ category: 'Multimedia & Lainnya', subcategory: 'Switcher & Recorder', brand: 'Blackmagic', model: 'ATEM Mini Pro', serial: 'A1234' });
  call('storage.save', { storageType: 'Koper', storageId: 'KOPER-01', name: 'Koper kamera Sony', note: '3 body, 2 lensa, baterai', createNew: true });
  call('storage.save', { storageType: 'Pouch', name: 'Pouch kabel HDMI', createNew: true });
  call('storage.assign', { storageId: 'KOPER-01', ids: bodies.concat(lenses, batteries.slice(0, 4)) });
  call('storage.assign', { storageId: 'POU-001', ids: cables });
  call('commit', { action: 'INSPEKSI', ids: bodies.concat(lenses), condition: 'Good', status: 'Active' });
  call('commit', { action: 'INSPEKSI', ids: [lights[1]], condition: 'Broken', status: 'Active', note: 'lampu tidak menyala' });
  call('commit', { action: 'INSPEKSI', ids: [tripods[1]], condition: 'Need Maintenance', status: 'Active', note: 'kaki seret' });
  call('commit', { action: 'INSPEKSI', ids: [batteries[7]], condition: 'Good', status: 'Passive' });
  call('commit', { action: 'KELUAR', ids: cables.slice(0, 3), location: 'Wisuda UGM' });
}

// A stand-in for opening the Google Sheet: the tabs the script writes to, refreshed every two seconds.
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
