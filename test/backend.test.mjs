import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGas } from './fake-gas.mjs';

// Bagas's media equipment (Format Inventaris Alat Media, 26 Okt 2026).
const CAM = { category: 'Kamera', subcategory: 'SONY Camera', brand: 'Sony', model: 'A7 III' };
const CABLE = { category: 'Camera Support & Accessories', subcategory: 'Cable / Kabel', brand: 'Ugreen', model: 'HDMI 2m' };
const CASE_LABEL = 'KOPER-01';

function boot() {
  const gas = createFakeGas({ now: () => new Date(2026, 9, 28, 10, 0, 0) });
  gas.setup();
  const code = gas.adminCode();
  const call = (action, payload = {}, extra = {}) => gas.handle({ user: 'admin', code, action, payload, ...extra });
  const ok = (action, payload, extra) => {
    const r = call(action, payload, extra);
    assert.equal(r.ok, true, `${action} failed: ${r.error}`);
    return r.data;
  };
  const fail = (action, payload, extra) => {
    const r = call(action, payload, extra);
    assert.equal(r.ok, false, `${action} should have failed`);
    return r;
  };
  // three identical cables without serial numbers: CS-CBL-UGR-001 .. 003
  const cables = () => ok('item.add', { ...CABLE, quantity: 3 }).addedIds;
  return { gas, code, call, ok, fail, cables };
}

test('setup creates the seven tabs, seeds the lists and an admin; safe to run again', () => {
  const { gas, code } = boot();
  assert.deepEqual([...gas.sheets.keys()], ['Items', 'Storage', 'Transactions', 'Carts', 'Lists', 'Users', 'Impor']);
  assert.match(code, /^\d{6}$/);
  assert.equal(gas.sheets.get('Items').data[0][0], 'id');
  const lists = gas.rows('Lists').length;
  assert.ok(lists > 30, 'Bagas\'s categories are seeded');
  assert.equal(gas.setup(), 'ok', 'setup is idempotent');
  assert.equal(gas.rows('Users').length, 1);
  assert.equal(gas.rows('Lists').length, lists, 'lists the team edited are never reseeded');
});

test('setup moves a sheet from the LED-screen version: empty tabs take the new columns, old data is kept under a new name', () => {
  const gas = createFakeGas();
  const ss = gas.ctx.SpreadsheetApp.getActiveSpreadsheet();
  ss.insertSheet('Items').getRange(1, 1, 1, 4).setValues([['id', 'qr_value', 'type', 'name']]);
  ss.insertSheet('Containers').getRange(1, 1, 1, 2).setValues([['cabinet_id', 'container_type']]);
  gas.setup();
  assert.ok(gas.sheets.has('Storage') && !gas.sheets.has('Containers'));
  assert.equal(gas.sheets.get('Storage').data[0][0], 'storage_id');
  assert.equal(gas.sheets.get('Items').data[0][2], 'category');
  // LED-era tabs that hold data are kept under a new name; fresh tabs take the media columns
  const gas2 = createFakeGas();
  const ss2 = gas2.ctx.SpreadsheetApp.getActiveSpreadsheet();
  ss2.insertSheet('Items').getRange(1, 1, 2, 3).setValues([['id', 'type', 'cabinet_id'], ['1-MVG-12-25-NY-MD.001', 'MODUL', 'BOX-001']]);
  ss2.insertSheet('Transactions').getRange(1, 1, 2, 3).setValues([['ts', 'action', 'item_type'], ['2026-10-22 14:19:03', 'IMPORT', 'MODUL']]);
  ss2.insertSheet('Containers').getRange(1, 1, 2, 2).setValues([['cabinet_id', 'container_type'], ['BOX-001', 'BOX']]);
  gas2.setup();
  assert.equal(gas2.sheets.get('Items (LED lama)').data[1][0], '1-MVG-12-25-NY-MD.001', 'old items kept');
  assert.equal(gas2.sheets.get('Transactions (LED lama)').data[1][1], 'IMPORT', 'old history kept');
  assert.equal(gas2.sheets.get('Containers (LED lama)').data[1][0], 'BOX-001', 'old containers kept');
  assert.equal(gas2.sheets.get('Items').data[0][2], 'category', 'a fresh Items tab with the new columns');
  assert.equal(gas2.rows('Items').length, 0);
  // any other tab that holds data with other columns is never rewritten
  const gas3 = createFakeGas();
  gas3.ctx.SpreadsheetApp.getActiveSpreadsheet().insertSheet('Items').getRange(1, 1, 2, 2).setValues([['id', 'merk_lain'], ['X-1', 'Y']]);
  assert.throws(() => gas3.setup(), /sudah berisi data/);
});

test('login: wrong code fails, lockout after ten failures, operator cannot add items', () => {
  const { gas, code } = boot();
  const bad = gas.handle({ user: 'admin', code: 'nope', action: 'bootstrap' });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /salah/);
  for (let i = 0; i < 9; i++) gas.handle({ user: 'admin', code: 'nope', action: 'bootstrap' });
  assert.match(gas.handle({ user: 'admin', code, action: 'bootstrap' }).error, /Terlalu banyak/);
  gas.sheets.get('Users').getRange(3, 1, 1, 4).setValues([['Reza', '1234', 'operator', 'TRUE']]);
  const op = gas.handle({ user: 'reza', code: '1234', action: 'bootstrap' });
  assert.equal(op.ok, true);
  assert.equal(op.data.me.role, 'operator');
  assert.match(gas.handle({ user: 'Reza', code: '1234', action: 'item.add', payload: { ...CAM, serial: '123' } }).error, /admin/);
  gas.sheets.get('Users').getRange(3, 4, 1, 1).setValues([['FALSE']]);
  assert.equal(gas.handle({ user: 'Reza', code: '1234', action: 'bootstrap' }).ok, false);
});

test('bootstrap on an empty sheet carries the lists, conditions and statuses', () => {
  const { ok } = boot();
  const d = ok('bootstrap');
  assert.equal(d.me.name, 'admin');
  assert.deepEqual(d.lists.categories.map(c => c.value), ['Kamera', 'Lensa', 'Lighting', 'Camera Support & Accessories', 'Multimedia & Lainnya']);
  assert.equal(d.lists.categories[0].code, 'KM');
  assert.ok(d.lists.subcategories.some(s => s.value === 'E Mount' && s.parent === 'Lensa' && s.code === 'EMT'));
  assert.deepEqual(d.lists.places, ['Storage', 'Drybox']);
  assert.deepEqual(d.lists.storageTypes.map(t => t.value), ['Pouch', 'Tas', 'Koper', 'Kontainer']);
  assert.deepEqual(d.conditions, ['Good', 'Need Maintenance', 'Broken', 'Untested']);
  assert.deepEqual(d.statuses, ['Active', 'Passive']);
  assert.equal(d.onDuty, 'On Duty');
  assert.deepEqual(d.stats, { total: 0, good: 0, needMaintenance: 0, broken: 0, untested: 0, onDuty: 0, inStorage: 0, passive: 0, storages: 0 });
});

test('item codes: category-subcategory-brand-last 4 of SN, or a running number per unit without SN', () => {
  const { gas, ok, fail } = boot();
  const a = ok('item.add', { ...CAM, serial: 'SN-0012304567', location: 'Drybox', note: 'body only' });
  assert.deepEqual(a.addedIds, ['KM-SON-SON-4567']);
  const it = a.items[0];
  assert.deepEqual([it.name, it.location, it.condition, it.status, it.out, it.note], ['Sony A7 III', 'Drybox', 'Untested', 'Active', false, 'body only']);
  assert.deepEqual(ok('item.add', { ...CAM, serial: 'XY9994567' }).addedIds, ['KM-SON-SON-4567-2'], 'same last four: a suffix keeps it unique');
  assert.deepEqual(ok('item.add', { ...CABLE, quantity: 3 }).addedIds, ['CS-CBL-UGR-001', 'CS-CBL-UGR-002', 'CS-CBL-UGR-003']);
  assert.deepEqual(ok('item.add', { ...CABLE }).addedIds, ['CS-CBL-UGR-004'], 'the running number continues');
  assert.deepEqual(ok('item.add', { category: 'Lighting', subcategory: 'Godox', brand: 'LG', model: 'Panel' }).addedIds, ['LG-GDX-LGX-001'], 'a short brand is padded');
  const lab = ok('item.add', { ...CAM, ids: 'OLD-1\nOLD-2\nOLD-1\nKM-SON-SON-4567' });
  assert.deepEqual([lab.addedCount, lab.skippedCount], [2, 2], 'labels already printed: used as they are, duplicates skipped');
  assert.equal(gas.rows('Transactions').length, 9, 'one IMPORT row per unit: 1 + 1 + 3 + 1 + 1 + 2');
  assert.equal(gas.rows('Transactions')[0][2], 'IMPORT');
  assert.match(fail('item.add', { ...CAM, subcategory: 'E Mount' }).error, /sub-kategori/);
  assert.match(fail('item.add', { ...CAM, category: 'Drone' }).error, /kategori/);
  assert.match(fail('item.add', { ...CAM, brand: '' }).error, /Merk/);
  assert.match(fail('item.add', { ...CAM, model: '' }).error, /Type/);
  assert.match(fail('item.add', { ...CABLE, quantity: 500 }).error, /Jumlah/);
  assert.match(fail('item.add', { ...CAM, location: 'Gudang' }).error, /lokasi/);
});

test('Impor tab: a check marks codes without adding, the import adds what passed, never twice', () => {
  const { gas, ok } = boot();
  ok('item.add', { ...CAM, serial: '5075230' });  // already registered: KM-SON-SON-5230
  const COLS = ['baris_lama', 'category', 'subcategory', 'brand', 'model', 'serial', 'location', 'condition',
    'condition_note', 'status', 'note', 'cek', 'kode', 'hasil'];
  const row = o => COLS.map(c => o[c] || '');
  const SD = { category: 'Camera Support & Accessories', subcategory: 'Memory', brand: 'Lexar', model: '800x 32GB', condition: 'Good' };
  const rows = [
    row({ baris_lama: '164', ...SD, note: 'Kode lama: F1' }),
    row({ baris_lama: '164', ...SD, note: 'Kode lama: F2', cek: 'dibawa GFA atau BIP?' }),
    row({ baris_lama: '164', ...SD, note: 'Kode lama: F3' }),
    row({ baris_lama: '109', category: 'Kamera', subcategory: 'SONY Camera', brand: 'Sony', model: 'A7Cii', serial: '3150972', location: 'Drybox' }),
    row({ baris_lama: '110', category: 'Kamera', subcategory: 'SONY Camera', brand: 'Sony', model: 'A6500', serial: '5075230' }),
    row({ baris_lama: '77', category: 'Camera Support & Accessories', subcategory: 'Battery & Charger', brand: 'Baseus', model: 'Powerbank', condition: 'Broken' }),
    row({ baris_lama: '2', category: 'Multimedia & Lainnya', subcategory: 'Audio', brand: 'Sony', model: 'ECM-B10', serial: '572736350' }),
    row({ baris_lama: '178', category: 'Multimedia & Lainnya', brand: 'Wanbo', model: 'T6 Max' })
  ];
  const imp = gas.sheets.get('Impor');
  imp.getRange(2, 1, rows.length, COLS.length).setValues(rows);
  const kode = () => gas.rows('Impor').map(r => r[12]);
  const hasil = () => gas.rows('Impor').map(r => r[13]);

  assert.equal(gas.ctx.checkImport(), '4 siap, 1 menunggu cek, 3 belum bisa. Belum ada yang dimasukkan.');
  assert.equal(gas.rows('Items').length, 1, 'a check adds nothing');
  assert.deepEqual(kode(), ['', '', '', '', '', '', '', '']);
  assert.deepEqual(hasil().map(h => h.replace(/:.*/, '')), ['Siap, kode nanti CS-MEM-LEX-001', 'Menunggu cek', 'Siap, kode nanti CS-MEM-LEX-002',
    'Siap, kode nanti KM-SON-SON-0972', 'Belum bisa', 'Belum bisa', 'Siap, kode nanti ML-AUD-SON-6350', 'Belum bisa']);
  assert.match(hasil()[4], /sudah terdaftar sebagai KM-SON-SON-5230/);
  assert.match(hasil()[5], /condition_note/);
  assert.match(hasil()[7], /sub-kategori/);
  assert.equal(imp.bg[2][0], '#fff2cc', 'a row waiting for a person is yellow');
  assert.equal(imp.bg[5][0], '#f4cccc', 'a row that cannot go in is red');

  assert.equal(gas.ctx.runImport(), '4 aset masuk, 1 menunggu cek, 3 belum bisa.');
  assert.deepEqual(kode(), ['CS-MEM-LEX-001', '', 'CS-MEM-LEX-002', 'KM-SON-SON-0972', '', '', 'ML-AUD-SON-6350', '']);
  const added = gas.rows('Items').find(r => r[0] === 'KM-SON-SON-0972');
  assert.deepEqual([added[7], added[12], added[18]], ['Drybox', '', 'Impor']);
  assert.match(gas.rows('Transactions').at(-1)[12], /Impor dari baris 2/);
  assert.equal(imp.bg[1][0], '#d9ead3', 'an added row is green');

  // the person clears cek, fixes the broken one; a second run adds only those
  imp.getRange(3, 12).setValues([['']]);
  imp.getRange(7, 9).setValues([['tidak bisa mengisi']]);
  assert.equal(gas.ctx.runImport(), '2 aset masuk, 0 menunggu cek, 2 belum bisa.');
  assert.deepEqual(kode().slice(0, 6), ['CS-MEM-LEX-001', 'CS-MEM-LEX-003', 'CS-MEM-LEX-002', 'KM-SON-SON-0972', '', 'CS-BAT-BAS-001']);
  assert.equal(gas.rows('Items').length, 7, '1 before + 4 + 2, nothing twice');
  assert.equal(gas.rows('Items').find(r => r[0] === 'CS-BAT-BAS-001')[11], 'tidak bisa mengisi');
});

test('check-out, check-in and condition check follow Bagas\'s forms', () => {
  const { gas, ok, fail, cables } = boot();
  const ids = cables();
  assert.match(fail('commit', { action: 'KELUAR', ids }).error, /Lokasi tujuan/);
  const out = ok('commit', { action: 'KELUAR', ids: ids.slice(0, 2), location: 'Wisuda UGM' }, { batchId: 'b1' });
  assert.equal(out.stats.onDuty, 2);
  const x = out.items.find(i => i.id === ids[0]);
  assert.deepEqual([x.location, x.destination, x.out], ['On Duty', 'Wisuda UGM', true]);
  const t = out.transactions[0];
  assert.deepEqual([t.action, t.event_date, t.from, t.to, t.user, t.batch_id], ['KELUAR', '2026-10-28', 'Storage', 'Wisuda UGM', 'admin', 'b1'], 'date and person come from the server');
  assert.deepEqual(fail('commit', { action: 'KELUAR', ids, location: 'X' }).invalid, ids.slice(0, 2));
  assert.equal(gas.rows('Transactions').length, 5, 'a refused batch writes nothing');

  ok('commit', { action: 'INSPEKSI', ids: [ids[2]], condition: 'Good', status: 'Passive' });
  const passive = fail('commit', { action: 'KELUAR', ids: [ids[2]], location: 'X' });
  assert.match(passive.error, /Passive/);
  assert.deepEqual(passive.invalid, [ids[2]]);

  assert.match(fail('commit', { action: 'MASUK', ids: ids.slice(0, 2) }).error, /tempat simpan/);
  assert.match(fail('commit', { action: 'MASUK', ids: ids.slice(0, 2), storeLocation: 'Gudang' }).error, /tempat simpan/);
  assert.deepEqual(fail('commit', { action: 'MASUK', ids: [ids[2]], storeLocation: 'Drybox' }).invalid, [ids[2]]);
  const back = ok('commit', { action: 'MASUK', ids: ids.slice(0, 2), storeLocation: 'drybox' });
  assert.equal(back.stats.onDuty, 0);
  const y = back.items.find(i => i.id === ids[0]);
  assert.deepEqual([y.location, y.destination], ['Drybox', '']);
  assert.deepEqual([back.transactions[0].from, back.transactions[0].to], ['Wisuda UGM', 'Drybox'], 'origin comes from the check-out');

  assert.match(fail('commit', { action: 'INSPEKSI', ids, status: 'Active' }).error, /hasil pemeriksaan/);
  assert.match(fail('commit', { action: 'INSPEKSI', ids, condition: 'Good' }).error, /status/);
  assert.match(fail('commit', { action: 'INSPEKSI', ids: [ids[0]], condition: 'Broken', status: 'Active' }).error, /Catatan wajib/);
  assert.match(fail('commit', { action: 'INSPEKSI', ids: [ids[0]], condition: 'Need Maintenance', status: 'Active' }).error, /Catatan wajib/);
  const broken = ok('commit', { action: 'INSPEKSI', ids: [ids[0]], condition: 'broken', status: 'active', note: 'konektor patah' });
  const z = broken.items.find(i => i.id === ids[0]);
  assert.deepEqual([z.condition, z.conditionNote, z.status, z.lastCheckedAt], ['Broken', 'konektor patah', 'Active', '2026-10-28 10:00:00']);
  assert.equal(broken.stats.broken, 1);
  const good = ok('commit', { action: 'INSPEKSI', ids, condition: 'Good', status: 'Active' });
  assert.deepEqual([good.stats.good, good.stats.broken, good.stats.passive], [3, 0, 0]);
  assert.equal(good.items.find(i => i.id === ids[0]).conditionNote, '');
  assert.deepEqual(fail('commit', { action: 'INSPEKSI', ids: ['NOPE'], condition: 'Good', status: 'Active' }).invalid, ['NOPE']);
});

test('a retried batch id is not written twice', () => {
  const { gas, ok, call, cables } = boot();
  const ids = cables();
  ok('commit', { action: 'KELUAR', ids, location: 'X' }, { batchId: 'same' });
  const n = gas.rows('Transactions').length;
  const r = call('commit', { action: 'KELUAR', ids, location: 'X' }, { batchId: 'same' });
  assert.equal(r.ok, true);
  assert.equal(r.repeated, true);
  assert.equal(gas.rows('Transactions').length, n);
});

test('storage: types from the list, auto IDs, a case label as ID, assign, lookup, unassign', () => {
  const { ok, fail, cables } = boot();
  const ids = cables();
  assert.equal(ok('storage.nextId', { storageType: 'Pouch' }).storageId, 'POU-001');
  assert.equal(ok('storage.nextId', { storageType: 'koper' }).storageId, 'KOP-001');
  fail('storage.nextId', { storageType: 'Kabinet' });
  assert.equal(ok('storage.save', { storageType: 'Pouch', name: 'Pouch kabel', createNew: true }).storageId, 'POU-001');
  assert.equal(ok('storage.nextId', { storageType: 'Pouch' }).storageId, 'POU-002');
  const custom = ok('storage.save', { storageType: 'Koper', storageId: CASE_LABEL, name: 'Koper kamera', note: 'Sony set', createNew: true });
  assert.equal(custom.storages.find(s => s.storageId === CASE_LABEL).storageType, 'Koper');
  fail('storage.save', { storageType: 'Koper', storageId: CASE_LABEL, name: 'dup', createNew: true });
  fail('storage.save', { storageType: 'Koper', storageId: 'has space', name: 'x', createNew: true });
  fail('storage.save', { storageType: 'Pouch', name: '', createNew: true });
  assert.equal(ok('storage.save', { storageId: CASE_LABEL, name: 'Koper kamera A' }).storages.find(s => s.storageId === CASE_LABEL).name, 'Koper kamera A');

  const assigned = ok('storage.assign', { storageId: CASE_LABEL, ids: ids.slice(0, 2) });
  assert.equal(assigned.storages.find(s => s.storageId === CASE_LABEL).itemCount, 2);
  assert.equal(assigned.items.find(x => x.id === ids[0]).storageId, CASE_LABEL);
  const moved = ok('storage.assign', { storageId: 'POU-001', ids: [ids[0]] });
  assert.equal(moved.storages.find(s => s.storageId === CASE_LABEL).itemCount, 1);
  assert.match(moved.transactions[0].note, /Dipindah dari/);
  fail('storage.assign', { storageId: 'POU-999', ids: [ids[0]] });
  assert.deepEqual(fail('storage.assign', { storageId: 'POU-001', ids: ['NOPE'] }).invalid, ['NOPE']);

  const look = ok('lookup', { code: CASE_LABEL.toLowerCase() });
  assert.equal(look.storage.storageId, CASE_LABEL);
  assert.equal(look.item, null);
  assert.deepEqual(look.members.map(m => m.id), [ids[1]]);
  assert.equal(ok('lookup', { code: ids[2] }).storage, null);
  fail('lookup', { code: 'NOPE' });

  const out = ok('commit', { action: 'KELUAR', ids: [ids[1]], location: 'X' });
  assert.equal(out.storages.find(s => s.storageId === CASE_LABEL).outCount, 1);
  assert.equal(out.transactions[0].storage_id, CASE_LABEL, 'transaction rows carry the item\'s storage');
  const un = ok('storage.unassign', { ids: [ids[1], ids[2]] });
  assert.equal(un.storages.find(s => s.storageId === CASE_LABEL).itemCount, 0);
  assert.equal(un.transactions[0].action, 'LEPAS');
  assert.equal(un.transactions[0].storage_id, CASE_LABEL);
});

test('edit, deactivate and per-item history', () => {
  const { ok, fail } = boot();
  const id = ok('item.add', { ...CAM, serial: '1234' }).addedIds[0];
  ok('storage.save', { storageType: 'Tas', name: 'Tas kamera', createNew: true });
  ok('storage.assign', { storageId: 'TAS-001', ids: [id] });
  assert.equal(ok('item.update', { id, brand: 'Sony' }).message, 'Tidak ada perubahan.');
  const ed = ok('item.update', { id, model: 'A7 IV', serial: '5678', status: 'Passive', location: 'Drybox', note: 'baru servis', subcategory: 'SONY Camera' });
  const it = ed.items.find(x => x.id === id);
  assert.deepEqual([it.name, it.serial, it.status, it.location, it.note, it.id], ['Sony A7 IV', '5678', 'Passive', 'Drybox', 'baru servis', id], 'the code never changes');
  assert.equal(ed.transactions[0].action, 'EDIT');
  fail('item.update', { id, brand: '' });
  fail('item.update', { id, subcategory: 'E Mount' });
  fail('item.update', { id, status: 'Rusak' });
  fail('item.update', { id: 'NOPE', model: 'x' });
  assert.deepEqual(ok('history', { itemId: id }).transactions.map(t => t.action), ['EDIT', 'KELOMPOK', 'IMPORT']);
  const de = ok('item.deactivate', { ids: [id, 'NOPE'] });
  assert.equal(de.items.length, 0);
  assert.equal(de.storages[0].itemCount, 0);
  assert.match(de.message, /1 barang/);
  fail('lookup', { code: id });
  assert.deepEqual(ok('item.add', { ...CAM, serial: '991234' }).addedIds, ['KM-SON-SON-1234-2'], 'a removed code is never handed out again');
});

test('unknown action and malformed input never crash', () => {
  const { call } = boot();
  assert.match(call('nope').error, /tidak dikenal/);
  assert.equal(call('commit', { action: 'TERBANG', ids: ['x'] }).ok, false);
  assert.equal(call('commit', { action: 'KELUAR', ids: [] }).ok, false);
  assert.equal(call('item.add', null).ok, false);
  assert.equal(call('storage.save', { storageType: 42 }).ok, false);
  assert.equal(call('cart.apply', { ops: [{ op: 'add', flow: 'nowhere', items: [{ id: 'A' }] }, null, { op: 'remove', flow: 'out', ids: 7 }] }).ok, true);
});

test('shared cart: two devices on one login, separate logins, save drops what was saved', () => {
  const { gas, code, ok, fail, cables } = boot();
  const ids = cables();
  gas.sheets.get('Users').getRange(3, 1, 1, 4).setValues([['Reza', '5555', 'operator', 'TRUE']]);
  const reza = (action, payload = {}) => gas.handle({ user: 'reza', code: '5555', action, payload });
  const first = ok('bootstrap').cart;
  assert.equal(first.rev, 0);
  assert.deepEqual(first.carts, { check: [], out: [], in: [], group: [] });

  ok('cart.apply', { ops: [{ op: 'add', flow: 'out', items: [{ id: ids[0], cab: '' }] }] });
  const afterB = ok('cart.apply', { ops: [{ op: 'add', flow: 'out', items: [{ id: ids[1], cab: '' }, { id: ids[0], cab: 'POU-001' }] }] });
  assert.deepEqual(afterB.carts.out, [{ id: ids[1], cab: '' }, { id: ids[0], cab: 'POU-001' }], 'two phones in the same second: both scans kept');
  assert.ok(afterB.rev > first.rev, 'revision grows');
  assert.deepEqual(ok('cart.get').carts.out.map(e => e.id), [ids[1], ids[0]]);
  assert.match(ok('cart.get').dataRev, /^\d+\.\d+\.\d+$/);
  assert.deepEqual(reza('cart.get').data.carts.out, [], 'another login has its own cart');

  ok('cart.apply', { ops: [{ op: 'target', id: 'POU-001' }, { op: 'add', flow: 'group', items: [{ id: ids[2] }] }] });
  const st = ok('cart.apply', { ops: [{ op: 'remove', flow: 'group', ids: [ids[2]] }] });
  assert.equal(st.target, 'POU-001');
  assert.deepEqual(st.carts.group, []);

  const saved = ok('commit', { action: 'KELUAR', ids: [ids[1], ids[0]], location: 'Hall', fromCart: true }, { batchId: 'b-1' });
  assert.deepEqual(saved.cart.carts.out, []);
  const before = gas.rows('Transactions').length;
  const twice = fail('commit', { action: 'KELUAR', ids: [ids[1], ids[0]], location: 'Hall', fromCart: true }, { batchId: 'b-2' });
  assert.match(twice.error, /sudah disimpan/);
  assert.equal(gas.rows('Transactions').length, before, 'a second Simpan writes nothing');

  ok('cart.apply', { ops: [{ op: 'add', flow: 'check', items: [{ id: ids[2] }] }] });
  const part = ok('commit', { action: 'INSPEKSI', ids: [ids[2], ids[0]], condition: 'Good', status: 'Active', fromCart: true }, { batchId: 'b-4' });
  assert.match(part.message, /1 unit\. 1 ID dilewati/);

  const seen = ok('cart.get').rev;
  gas.sheets.get('Carts').getRange(2, 1, 1, 4).setValues([['', '', '', '']]);
  for (const until = Date.now() + 30; Date.now() < until;) { /* real saves are seconds apart; here, a few ms */ }
  const fresh = ok('cart.apply', { ops: [{ op: 'add', flow: 'out', items: [{ id: ids[0] }] }] });
  assert.ok(fresh.rev > seen, `revision after a manual clear (${fresh.rev}) must exceed ${seen}`);
  assert.equal(gas.rows('Carts').filter(r => r[0]).length, 1);
  assert.equal(code.length, 6);
});
