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

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8791, CDP = 9333;
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
if (!fs.existsSync(CHROME)) { console.log('SKIP: Chrome not found at ' + CHROME); process.exit(0); }

const server = spawn(process.execPath, [path.join(here, 'dev-server.mjs'), String(PORT)], { stdio: ['ignore', 'pipe', 'inherit'] });
let adminCode = '';
server.stdout.on('data', d => { const m = /admin \/ (\d+)/.exec(String(d)); if (m) adminCode = m[1]; });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'inv-smoke-'));
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${CDP}`, `--user-data-dir=${profile}`, '--no-first-run', '--window-size=420,900', 'about:blank'], { stdio: 'ignore' });
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
check('recent transactions render', (await evaluate(`document.querySelectorAll('#homeRecent tbody tr').length`)) === 8);
check('session persisted', (await evaluate(`JSON.parse(localStorage.getItem('inventory-scanner.session')).user`)) === 'admin');

await evaluate(`inventoryApp.showPage('inventory'); document.querySelectorAll('#inventoryList .item').length`);
check('inventory list renders', (await evaluate(`document.querySelectorAll('#inventoryList .item').length`)) === 48);
await evaluate(`document.getElementById('inventoryFilter').value='out'; document.getElementById('inventoryFilter').dispatchEvent(new Event('change')); true`);
check('filter "Di luar" works', (await evaluate(`document.querySelectorAll('#inventoryList .item').length`)) === 8);
await evaluate(`document.getElementById('inventoryFilter').value=''; document.getElementById('inventorySearch').value='psu'; document.getElementById('inventorySearch').dispatchEvent(new Event('input')); true`);
check('search works', (await evaluate(`document.querySelectorAll('#inventoryList .item').length`)) === 6);

await evaluate(`inventoryApp.setFlow('out'); inventoryApp.showPage('scan'); true`);
check('scan page active', await evaluate(`document.getElementById('page-scan').classList.contains('active')`));
check('scan unknown code is refused', (await evaluate(`inventoryApp.handleCode('NOPE-123')`)) === false);
check('scan single module', (await evaluate(`inventoryApp.handleCode('1-MVG-12-25-NY-MD.030')`)) === true && (await evaluate(`inventoryApp.carts.out.length`)) === 1);
check('scan same code again is a duplicate', (await evaluate(`inventoryApp.handleCode('1-MVG-12-25-NY-MD.030')`)) === false);
await evaluate(`inventoryApp.handleCode('2-MVG-12-25-NY-BX.001')`);
check('scanning a box label adds its 16 members plus the box itself', (await evaluate(`inventoryApp.carts.out.length`)) === 18, 'cart=' + await evaluate(`inventoryApp.carts.out.length`));
check('cart renders rows', (await evaluate(`document.querySelectorAll('#cartList .item').length`)) === 18);

await evaluate(`document.getElementById('location-out').value='Ballroom Hotel ABC'; document.getElementById('event-out').value='Wisuda'; inventoryApp.saveFlow(); true`);
await sleep(200);
check('confirm dialog opens', await evaluate(`document.getElementById('dlg').open === true`));
await evaluate(`document.querySelector('#dlg [data-r="1"]').click(); true`);
await sleep(600);
const toast1 = await evaluate(`document.getElementById('toast').textContent`);
check('refused check-out drops the 8 items already out', (await evaluate(`inventoryApp.carts.out.length`)) === 10, 'toast: ' + toast1.slice(0, 90));
await evaluate(`inventoryApp.saveFlow(); true`);
await sleep(200);
await evaluate(`document.querySelector('#dlg [data-r="1"]').click(); true`);
await sleep(600);
check('second save succeeds and clears the cart', (await evaluate(`inventoryApp.carts.out.length`)) === 0, 'toast: ' + await evaluate(`document.getElementById('toast').textContent`));
check('stats updated: 18 out', (await evaluate(`inventoryApp.state().stats.out`)) === 18);
check('location field reset', (await evaluate(`document.getElementById('location-out').value`)) === '');

await evaluate(`inventoryApp.setFlow('group'); true`);
check('scanning a box in group flow sets it as the target', (await evaluate(`inventoryApp.handleCode('2-MVG-12-25-NY-BX.001')`)) === true && (await evaluate(`document.getElementById('groupTarget').value`)) === '2-MVG-12-25-NY-BX.001');
check('then scanning a module adds it', (await evaluate(`inventoryApp.handleCode('1-MVG-12-25-NY-MD.031')`)) === true && (await evaluate(`inventoryApp.carts.group.length`)) === 1);

await evaluate(`inventoryApp.showPage('labels'); document.getElementById('labelSearch').value='PSU'; document.getElementById('labelSearch').dispatchEvent(new Event('input')); document.getElementById('labelSelectAll').click(); window.print = () => { window.__printed = true; }; document.getElementById('labelPrint').click(); true`);
await sleep(400);
check('labels render as SVG and print is called', (await evaluate(`document.querySelectorAll('#printArea .qrcard svg').length`)) === 6 && (await evaluate(`window.__printed === true`)));

await evaluate(`inventoryApp.showPage('history'); true`);
check('history table renders', (await evaluate(`document.querySelectorAll('#historyTable tbody tr').length`)) > 40);

check('no console errors or exceptions', errors.length === 0, errors.join(' | ').slice(0, 400));
console.log(failed ? `\n${failed} check(s) failed` : '\nall smoke checks passed');
ws.close();
process.exit(failed ? 1 : 0);
