// Headless-Chrome smoke test of the front end against the dev server (real Code.gs on an in-memory sheet).
//   node test/smoke.mjs            needs Google Chrome on this Mac; starts its own dev server on port 8791.
// Checks: the page boots without console errors, logs in, renders stats, scanning a box label fills the
// cart, a refused check-out drops the offending IDs, the retried save succeeds, labels render as SVG.
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8791, CDP = 9333;
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
if (!fs.existsSync(CHROME)) { console.log('SKIP: Chrome not found at ' + CHROME); process.exit(0); }

const server = spawn(process.execPath, [path.join(here, 'dev-server.mjs'), String(PORT)], { stdio: ['ignore', 'pipe', 'inherit'] });
let adminCode = '';
server.stdout.on('data', d => { const m = /admin \/ (\d+)/.exec(String(d)); if (m) adminCode = m[1]; });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'inv-smoke-'));
// A fake phone camera: a tall 720x960 picture with one seeded label in the middle, 15 % of the frame width
// (about 15 cm away on a phone), so the camera loop itself is tested, not only typed IDs.
const CAM_LABEL = '1-MVG-12-25-NY-MD.036';
const camFile = path.join(profile, 'camera.y4m');
{
  const qrcode = createRequire(import.meta.url)(path.join(here, '..', 'vendor', 'qrcode.js'));
  const W = 720, H = 960, qr = qrcode(0, 'M'); qr.addData(CAM_LABEL); qr.make();
  const n = qr.getModuleCount(), size = Math.round(W * 0.15), cell = size / (n + 8), x0 = (W - size) >> 1, y0 = (H - size) >> 1;
  const Y = Buffer.alloc(W * H, 110);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const mx = Math.floor(x / cell) - 4, my = Math.floor(y / cell) - 4;
    Y[(y0 + y) * W + x0 + x] = mx >= 0 && my >= 0 && mx < n && my < n && qr.isDark(my, mx) ? 30 : 225;
  }
  const UV = Buffer.alloc(W * H / 4, 128), parts = [Buffer.from(`YUV4MPEG2 W${W} H${H} F10:1 Ip A1:1 C420jpeg\n`)];
  for (let f = 0; f < 4; f++) parts.push(Buffer.from('FRAME\n'), Y, UV, UV);
  fs.writeFileSync(camFile, Buffer.concat(parts));
}
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${CDP}`, `--user-data-dir=${profile}`, '--no-first-run', '--window-size=420,900',
  '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${camFile}`, 'about:blank'], { stdio: 'ignore' });
const cleanup = () => { try { chrome.kill(); } catch {} try { server.kill(); } catch {} try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {} };
process.on('exit', cleanup);

for (let i = 0; i < 50 && !adminCode; i++) await sleep(100);
let targets;
for (let i = 0; i < 50; i++) { try { targets = await (await fetch(`http://localhost:${CDP}/json`)).json(); break; } catch { await sleep(200); } }
const ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
await new Promise(r => ws.onopen = r);
let id = 0; const pending = new Map(); const errors = [];
ws.onmessage = ev => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  if (m.method === 'Runtime.exceptionThrown') errors.push('exception: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push('console.error: ' + m.params.args.map(a => a.value ?? a.description).join(' '));
  // navigator.vibrate is refused until the user has tapped the page; headless never taps, so that log line is noise.
  if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error' && !/navigator\.vibrate/.test(m.params.entry.text)) errors.push('log: ' + m.params.entry.text + ' ' + (m.params.entry.url || ''));
};
const send = (method, params = {}) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const evaluate = async expr => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result.exceptionDetails) throw new Error('evaluate failed: ' + JSON.stringify(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text) + ' in ' + expr.slice(0, 80));
  return r.result.result.value;
};
await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable');

let failed = 0;
const check = (name, ok, extra = '') => { console.log((ok ? '✔ ' : '✖ ') + name + (extra ? '  ' + extra : '')); if (!ok) failed++; };

await send('Page.navigate', { url: `http://localhost:${PORT}/` });
await sleep(800);
check('login view shown', await evaluate(`!document.getElementById('loginView').classList.contains('hidden')`));
await evaluate(`document.getElementById('loginUser').value='admin'; document.getElementById('loginCode').value='${adminCode}'; document.getElementById('loginForm').requestSubmit(); true`);
await sleep(800);
check('app view shown after login', await evaluate(`!document.getElementById('appView').classList.contains('hidden')`));
const stats = await evaluate(`[...document.querySelectorAll('#statCards .card')].map(c => c.querySelector('.label').textContent + '=' + c.querySelector('.num').textContent)`);
check('stat cards render', stats.length === 7 && stats[0] === 'Total unit aktif=48', stats.join(', '));
check('recent saves render as grouped rows', (await evaluate(`document.querySelectorAll('#homeRecent details').length`)) >= 4);
check('session persisted', (await evaluate(`JSON.parse(localStorage.getItem('inventory-scanner.session')).user`)) === 'admin');

await evaluate(`inventoryApp.showPage('inventory'); document.querySelectorAll('#inventoryList .item').length`);
check('inventory list renders', (await evaluate(`document.querySelectorAll('#inventoryList .item').length`)) === 48);
await evaluate(`document.querySelector('#inventoryFilter [data-f="out"]').click(); true`);
check('filter "Di luar" works', (await evaluate(`document.querySelectorAll('#inventoryList .item').length`)) === 8);
await evaluate(`document.querySelector('#inventoryFilter [data-f=""]').click(); document.getElementById('inventorySearch').value='psu'; document.getElementById('inventorySearch').dispatchEvent(new Event('input')); true`);
check('search works', (await evaluate(`document.querySelectorAll('#inventoryList .item').length`)) === 6);

await evaluate(`document.getElementById('inventorySearch').value=''; document.getElementById('inventorySearch').dispatchEvent(new Event('input')); document.querySelector('#inventoryList [data-open]').click(); true`);
await sleep(150);
check('tapping a row opens the action sheet', (await evaluate(`document.getElementById('dlg').open && document.querySelectorAll('#dlg .sheet-grid button').length`)) === 6);
await evaluate(`document.querySelector('#dlg [data-a="close"]').click(); document.getElementById('importBtn').click(); true`);
await sleep(150);
check('Tambah Aset opens a form dialog', (await evaluate(`document.getElementById('dlg').open && !!document.querySelector('#dlg textarea[name=ids]')`)) === true);
await evaluate(`document.querySelector('#dlg [data-r="0"]').click(); true`);
await evaluate(`inventoryApp.setFlow('out'); inventoryApp.showPage('scan'); true`);
check('scan page active', await evaluate(`document.getElementById('page-scan').classList.contains('active')`));
check('scan unknown code is refused', (await evaluate(`inventoryApp.handleCode('NOPE-123')`)) === false);
check('scan single module', (await evaluate(`inventoryApp.handleCode('1-MVG-12-25-NY-MD.030')`)) === true && (await evaluate(`inventoryApp.carts.out.length`)) === 1);
check('scan same code again is a duplicate', (await evaluate(`inventoryApp.handleCode('1-MVG-12-25-NY-MD.030')`)) === false);
await evaluate(`inventoryApp.handleCode('2-MVG-12-25-NY-BX.001')`);
check('scanning a box label adds its 16 members plus the box itself', (await evaluate(`inventoryApp.carts.out.length`)) === 18, 'cart=' + await evaluate(`inventoryApp.carts.out.length`));
check('cart renders rows', (await evaluate(`document.querySelectorAll('#cartList .item').length`)) === 18);

await send('Page.reload'); await sleep(1200);
check('cart survives a page reload', (await evaluate(`inventoryApp.carts.out.length`)) === 18 && (await evaluate(`document.getElementById('page-scan').classList.contains('active')`)));
check('newest scan is at the top of the cart', (await evaluate(`inventoryApp.carts.out[0].id`)) === '2-MVG-12-25-NY-BX.001' && (await evaluate(`inventoryApp.carts.out[17].id`)) === '1-MVG-12-25-NY-MD.030');
await evaluate(`inventoryApp.saveFlow(); true`);
await sleep(200);
check('Simpan opens the save sheet', await evaluate(`document.getElementById('dlg').open === true && !!document.querySelector('#dlg [name=location]')`));
await evaluate(`document.querySelector('#dlg form').requestSubmit(); true`);
await sleep(200);
check('save sheet refuses an empty location and stays open', await evaluate(`document.getElementById('dlg').open === true`));
await evaluate(`document.querySelector('#dlg [name=location]').value='Ballroom Hotel ABC'; document.querySelector('#dlg [name=eventName]').value='Wisuda'; document.querySelector('#dlg form').requestSubmit(); true`);
await sleep(600);
const toast1 = await evaluate(`document.getElementById('toast').textContent`);
check('refused check-out drops the 8 items already out', (await evaluate(`inventoryApp.carts.out.length`)) === 10, 'toast: ' + toast1.slice(0, 90));
await evaluate(`inventoryApp.saveFlow(); true`);
await sleep(200);
check('save sheet remembers the location from the refused attempt', (await evaluate(`document.querySelector('#dlg [name=location]').value`)) === 'Ballroom Hotel ABC');
await evaluate(`document.querySelector('#dlg form').requestSubmit(); true`);
await sleep(600);
check('second save succeeds and clears the cart', (await evaluate(`inventoryApp.carts.out.length`)) === 0, 'toast: ' + await evaluate(`document.getElementById('toast').textContent`));
check('stats updated: 18 out', (await evaluate(`inventoryApp.state().stats.out`)) === 18);
check('save button disabled on an empty cart', await evaluate(`document.getElementById('saveBtn').disabled === true`));

// Shared cart: a second device on the same login, played here by direct calls to the dev server's API.
const apiCall = async (action, payload = {}) => (await (await fetch(`http://localhost:${PORT}/api`, { method: 'POST', body: JSON.stringify({ user: 'admin', code: adminCode, action, payload }) })).json());
check('after the save the shared cart is empty on the server', (await apiCall('cart.get')).data.carts.out.length === 0);
await apiCall('cart.apply', { ops: [{ op: 'add', flow: 'out', items: [{ id: '1-MVG-12-25-NY-MD.032', cab: '' }] }] });
let seen = false;
for (let i = 0; i < 30 && !seen; i++) { await sleep(250); seen = (await evaluate(`inventoryApp.carts.out.length`)) === 1; }
check('a scan from another device on the same login shows here within seconds', seen);
await evaluate(`document.querySelector('#cartList [data-remove]').click(); true`);
await sleep(800);
check('removing it here removes it on the other device too', (await apiCall('cart.get')).data.carts.out.length === 0);
await evaluate(`inventoryApp.handleCode('1-MVG-12-25-NY-MD.033')`);
await sleep(800);
check('a scan here reaches the shared cart', (await apiCall('cart.get')).data.carts.out.map(e => e.id).join() === '1-MVG-12-25-NY-MD.033');
await apiCall('commit', { action: 'KELUAR', ids: ['1-MVG-12-25-NY-MD.033'], eventDate: '2026-10-21', location: 'Gudang B', fromCart: true });
let followed = false;
for (let i = 0; i < 30 && !followed; i++) { await sleep(250); followed = (await evaluate(`inventoryApp.carts.out.length`)) === 0 && (await evaluate(`inventoryApp.state().stats.out`)) === 19; }
check('a save on the other device empties this cart and updates the stats here', followed);

await evaluate(`inventoryApp.setFlow('group'); true`);
check('scanning a box in group flow sets it as the target', (await evaluate(`inventoryApp.handleCode('2-MVG-12-25-NY-BX.001')`)) === true && (await evaluate(`document.getElementById('groupTarget').value`)) === '2-MVG-12-25-NY-BX.001');
check('then scanning a module adds it', (await evaluate(`inventoryApp.handleCode('1-MVG-12-25-NY-MD.031')`)) === true && (await evaluate(`inventoryApp.carts.group.length`)) === 1);

await evaluate(`inventoryApp.showPage('labels'); document.getElementById('labelSearch').value='PSU'; document.getElementById('labelSearch').dispatchEvent(new Event('input')); document.getElementById('labelSelectAll').click(); window.print = () => { window.__printed = true; }; document.getElementById('labelPrint').click(); true`);
await sleep(400);
check('labels render as SVG and print is called', (await evaluate(`document.querySelectorAll('#printArea .qrcard svg').length`)) === 6 && (await evaluate(`window.__printed === true`)));

await evaluate(`inventoryApp.showPage('history'); true`);
check('history renders grouped saves', (await evaluate(`document.querySelectorAll('#historyTable details').length`)) >= 5);
await evaluate(`document.querySelector('#historyTable details').open = true; true`);
check('a save expands to its rows', (await evaluate(`document.querySelectorAll('#historyTable details[open] .rowline').length`)) > 0);
await evaluate(`window.__gum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices); navigator.mediaDevices.getUserMedia = () => Promise.reject(new Error('no camera in this check')); inventoryApp.showPage('inventory'); document.getElementById('lookupScanBtn').click(); true`);
await sleep(400);
check('scan-to-look-up dialog opens with a typed fallback', await evaluate(`document.getElementById('dlg').open && !!document.getElementById('lookupInput')`));
await evaluate(`document.getElementById('lookupInput').value='1-MVG-12-25-NY-MD.002'; document.getElementById('lookupGo').click(); true`);
await sleep(300);
check('typed look-up opens the item sheet', (await evaluate(`document.querySelector('#dlg h2') && document.querySelector('#dlg h2').textContent`)) === '1-MVG-12-25-NY-MD.002');
await evaluate(`document.querySelector('#dlg [data-a="close"]').click(); true`);

// A phone that still holds a cart saved by the previous app version (no shared cart yet) merges it in once.
await evaluate(`(() => { const k = Object.keys(localStorage).find(k => k.startsWith('inventory-scanner.cart.')); const v = JSON.parse(localStorage.getItem(k));
  localStorage.setItem(k, JSON.stringify({ carts: { check: [{ id: '1-MVG-12-25-NY-MD.035', cab: '' }], out: [], in: [], group: [] }, drafts: v.drafts, flow: 'check' })); return true; })()`);
await send('Page.reload'); await sleep(1800);
const merged = (await apiCall('cart.get')).data;
check('a cart from the previous app version is merged into the shared cart', merged.carts.check.some(e => e.id === '1-MVG-12-25-NY-MD.035') && merged.carts.group.some(e => e.id === '1-MVG-12-25-NY-MD.031'));

// The camera loop end to end: start the camera on the Scan page, the fake camera's label lands in the cart.
await evaluate(`if (window.__gum) navigator.mediaDevices.getUserMedia = window.__gum; inventoryApp.setFlow('in'); inventoryApp.showPage('scan'); document.getElementById('camStart').click(); true`);
let camHit = false;
for (let i = 0; i < 40 && !camHit; i++) { await sleep(200); camHit = await evaluate(`inventoryApp.carts.in.some(x => x.id === '${CAM_LABEL}')`); }
check('the camera reads a label held about 15 cm away and puts it in the cart', camHit, await evaluate(`JSON.stringify(inventoryApp.scanStats) + ' ' + document.getElementById('scanStatus').textContent`));
await evaluate(`document.getElementById('camStop').click(); true`);

check('no console errors or exceptions', errors.length === 0, errors.join(' | ').slice(0, 400));
console.log(failed ? `\n${failed} check(s) failed` : '\nall smoke checks passed');
ws.close();
process.exit(failed ? 1 : 0);
