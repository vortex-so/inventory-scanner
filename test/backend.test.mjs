import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGas } from './fake-gas.mjs';

const MODS = ['1-MVG-12-25-NY-MD.001', '1-MVG-12-25-NY-MD.002', '1-MVG-12-25-NY-MD.003'];
const BOX_LABEL = '2-MVG-12-25-NY-BX.001';

function boot() {
  const gas = createFakeGas({ now: () => new Date(2026, 9, 21, 10, 0, 0) });
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
  return { gas, code, call, ok, fail };
}

test('setup creates the five tabs and an admin', () => {
  const { gas, code } = boot();
  assert.deepEqual([...gas.sheets.keys()], ['Items', 'Containers', 'Transactions', 'Carts', 'Users']);
  assert.match(code, /^\d{6}$/);
  assert.equal(gas.sheets.get('Items').data[0][0], 'id');
  assert.equal(gas.setup(), 'ok', 'setup is idempotent');
  assert.equal(gas.rows('Users').length, 1);
});

test('login: wrong code fails, lockout after ten failures, operator cannot import', () => {
  const { gas, code } = boot();
  const bad = gas.handle({ user: 'admin', code: 'nope', action: 'bootstrap' });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /salah/);
  for (let i = 0; i < 9; i++) gas.handle({ user: 'admin', code: 'nope', action: 'bootstrap' });
  const locked = gas.handle({ user: 'admin', code, action: 'bootstrap' });
  assert.match(locked.error, /Terlalu banyak/);
  // a second, operator user
  gas.sheets.get('Users').getRange(3, 1, 1, 4).setValues([['Fajar', '1234', 'operator', 'TRUE']]);
  const op = gas.handle({ user: 'fajar', code: '1234', action: 'bootstrap' });
  assert.equal(op.ok, true);
  assert.equal(op.data.me.role, 'operator');
  const denied = gas.handle({ user: 'Fajar', code: '1234', action: 'item.import', payload: { type: 'MODUL', name: 'x', ids: ['A'] } });
  assert.match(denied.error, /admin/);
  const inactive = gas.sheets.get('Users').getRange(3, 4, 1, 1).setValues([['FALSE']]);
  assert.equal(gas.handle({ user: 'Fajar', code: '1234', action: 'bootstrap' }).ok, false);
});

test('bootstrap on an empty sheet', () => {
  const { ok } = boot();
  const d = ok('bootstrap');
  assert.equal(d.me.name, 'admin');
  assert.equal(d.types.length, 24);
  assert.deepEqual(d.stats, { total: 0, good: 0, damaged: 0, unchecked: 0, out: 0, inWarehouse: 0, boxes: 0 });
});

test('import keeps IDs as given, skips duplicates, logs one row per item', () => {
  const { gas, ok, fail } = boot();
  const d = ok('item.import', { type: 'modul', name: 'Modul LED P2.9', category: 'LED', ids: MODS.join('\n') + '\n' + MODS[0] });
  assert.equal(d.addedCount, 3);
  assert.equal(d.skippedCount, 1);
  assert.equal(d.items[0].id, MODS[0]);
  assert.equal(d.items[0].type, 'MODUL');
  assert.equal(d.items[0].locationStatus, 'DI GUDANG');
  assert.equal(d.items[0].location, 'Gudang');
  assert.equal(gas.rows('Transactions').length, 3);
  assert.equal(d.stats.unchecked, 3);
  fail('item.import', { type: 'MODUL', name: '', ids: ['Z'] });
  const tooMany = fail('item.import', { type: 'MODUL', name: 'x', ids: Array.from({ length: 2001 }, (_, i) => 'X' + i) });
  assert.match(tooMany.error, /2000/);
});

test('check-out, double check-out refused with the offending IDs, check-in, inspection', () => {
  const { gas, ok, fail } = boot();
  ok('item.import', { type: 'MODUL', name: 'Modul', ids: MODS });
  const out = ok('commit', { action: 'KELUAR', ids: MODS.slice(0, 2), eventDate: '2026-10-25', location: 'Ballroom Hotel ABC', eventName: 'Wisuda' }, { batchId: 'b1' });
  assert.equal(out.stats.out, 2);
  assert.equal(out.items.find(x => x.id === MODS[0]).location, 'Ballroom Hotel ABC');
  assert.equal(out.transactions[0].action, 'KELUAR');
  assert.equal(out.transactions[0].batch_id, 'b1');
  assert.equal(out.transactions[0].user, 'admin');

  const again = fail('commit', { action: 'KELUAR', ids: MODS, eventDate: '2026-10-26', location: 'X' }, { batchId: 'b2' });
  assert.deepEqual(again.invalid, MODS.slice(0, 2));
  assert.equal(gas.rows('Transactions').length, 5, 'a refused batch writes nothing');

  fail('commit', { action: 'KELUAR', ids: [MODS[2]], location: 'X' });            // no date
  fail('commit', { action: 'KELUAR', ids: [MODS[2]], eventDate: '2026-10-26' });  // no location
  const wrongIn = fail('commit', { action: 'MASUK', ids: [MODS[2]], eventDate: '2026-10-26', location: 'X' });
  assert.deepEqual(wrongIn.invalid, [MODS[2]]);

  const back = ok('commit', { action: 'MASUK', ids: MODS.slice(0, 2), eventDate: '2026-10-27', location: 'Ballroom Hotel ABC', storeLocation: 'Gudang Kubik' }, { batchId: 'b3' });
  assert.equal(back.stats.out, 0);
  assert.equal(back.items.find(x => x.id === MODS[0]).location, 'Gudang Kubik');

  const noNote = fail('commit', { action: 'INSPEKSI', ids: [MODS[0]], condition: 'RUSAK' });
  assert.match(noNote.error, /kerusakan/);
  const rusak = ok('commit', { action: 'INSPEKSI', ids: [MODS[0]], condition: 'RUSAK', damageNote: 'pixel mati' });
  assert.equal(rusak.stats.damaged, 1);
  assert.equal(rusak.items.find(x => x.id === MODS[0]).damageNote, 'pixel mati');
  const baik = ok('commit', { action: 'INSPEKSI', ids: MODS, condition: 'BAIK' });
  assert.deepEqual([baik.stats.good, baik.stats.damaged, baik.stats.unchecked], [3, 0, 0]);
  assert.equal(baik.items[0].damageNote, '');
  assert.equal(baik.items[0].lastCheckedAt, '2026-10-21 10:00:00');
  const missing = fail('commit', { action: 'INSPEKSI', ids: ['NOPE'], condition: 'BAIK' });
  assert.deepEqual(missing.invalid, ['NOPE']);
});

test('a retried batch id is not written twice', () => {
  const { gas, ok, call } = boot();
  ok('item.import', { type: 'MODUL', name: 'Modul', ids: MODS });
  ok('commit', { action: 'KELUAR', ids: MODS, eventDate: '2026-10-25', location: 'X' }, { batchId: 'same' });
  const n = gas.rows('Transactions').length;
  const r = call('commit', { action: 'KELUAR', ids: MODS, eventDate: '2026-10-25', location: 'X' }, { batchId: 'same' });
  assert.equal(r.ok, true);
  assert.equal(r.repeated, true);
  assert.equal(gas.rows('Transactions').length, n);
});

test('containers: auto IDs, custom box label as ID, assign, lookup, unassign', () => {
  const { ok, fail } = boot();
  ok('item.import', { type: 'MODUL', name: 'Modul', ids: MODS });
  ok('item.import', { type: 'BOX', name: 'Flight case', ids: [BOX_LABEL] });
  assert.equal(ok('container.nextId', { containerType: 'BOX' }).cabinetId, 'BOX-001');
  assert.equal(ok('container.nextId', { containerType: 'KABINET' }).cabinetId, 'KAB-001');
  fail('container.nextId', { containerType: 'RAK' });

  const auto = ok('container.save', { containerType: 'KABINET', name: 'Kabinet LED Utama', createNew: true });
  assert.equal(auto.cabinetId, 'KAB-001');
  assert.equal(ok('container.nextId', { containerType: 'KABINET' }).cabinetId, 'KAB-002');

  const custom = ok('container.save', { containerType: 'BOX', cabinetId: BOX_LABEL, name: 'Box 1', note: '4 x 4 modul', createNew: true });
  assert.equal(custom.cabinetId, BOX_LABEL);
  fail('container.save', { containerType: 'BOX', cabinetId: BOX_LABEL, name: 'dup', createNew: true });
  fail('container.save', { containerType: 'BOX', cabinetId: 'has space', name: 'x', createNew: true });

  const edited = ok('container.save', { cabinetId: BOX_LABEL, name: 'Box 1 (depan)', category: 'P2.9' });
  assert.equal(edited.containers.find(c => c.cabinetId === BOX_LABEL).name, 'Box 1 (depan)');
  assert.equal(edited.containers.length, 2);

  const assigned = ok('container.assign', { cabinetId: BOX_LABEL, ids: MODS.slice(0, 2) });
  const box = assigned.containers.find(c => c.cabinetId === BOX_LABEL);
  assert.equal(box.itemCount, 2);
  assert.equal(assigned.items.find(x => x.id === MODS[0]).cabinetId, BOX_LABEL);
  const moved = ok('container.assign', { cabinetId: 'KAB-001', ids: [MODS[0]] });
  assert.equal(moved.containers.find(c => c.cabinetId === BOX_LABEL).itemCount, 1);
  assert.equal(moved.containers.find(c => c.cabinetId === 'KAB-001').itemCount, 1);
  assert.match(moved.transactions[0].note, /Dipindah dari/);
  fail('container.assign', { cabinetId: 'BOX-999', ids: [MODS[0]] });
  const missing = fail('container.assign', { cabinetId: 'KAB-001', ids: ['NOPE'] });
  assert.deepEqual(missing.invalid, ['NOPE']);

  const look = ok('lookup', { code: BOX_LABEL.toLowerCase() });
  assert.equal(look.item.id, BOX_LABEL, 'the box label is also an item');
  assert.equal(look.container.cabinetId, BOX_LABEL);
  assert.deepEqual(look.members.map(m => m.id), [MODS[1]]);
  const lookItem = ok('lookup', { code: MODS[2] });
  assert.equal(lookItem.container, null);
  fail('lookup', { code: 'NOPE' });

  const out = ok('commit', { action: 'KELUAR', ids: [MODS[1], BOX_LABEL], eventDate: '2026-10-25', location: 'X' });
  assert.equal(out.containers.find(c => c.cabinetId === BOX_LABEL).outCount, 1);
  const modRow = out.transactions.find(t => t.item_id === MODS[1]);
  assert.equal(modRow.cabinet_id, BOX_LABEL, 'transaction rows carry the item\'s container');
  assert.equal(out.transactions.find(t => t.item_id === BOX_LABEL).cabinet_id, '', 'the box itself has no container');

  const un = ok('container.unassign', { ids: [MODS[1], MODS[2]] });
  assert.equal(un.containers.find(c => c.cabinetId === BOX_LABEL).itemCount, 0);
  assert.equal(un.transactions[0].action, 'LEPAS');
  assert.equal(un.transactions[0].cabinet_id, BOX_LABEL);
});

test('edit, deactivate and per-item history', () => {
  const { ok, fail } = boot();
  ok('item.import', { type: 'MODUL', name: 'Modul', ids: MODS });
  ok('container.save', { containerType: 'KABINET', name: 'K', createNew: true });
  ok('container.assign', { cabinetId: 'KAB-001', ids: [MODS[0]] });
  const same = ok('item.update', { id: MODS[0], name: 'Modul' });
  assert.equal(same.message, 'Tidak ada perubahan.');
  const ed = ok('item.update', { id: MODS[0], name: 'Modul LED', category: 'LED', location: 'IONs', type: 'modul backup' });
  const it = ed.items.find(x => x.id === MODS[0]);
  assert.deepEqual([it.name, it.category, it.location, it.type], ['Modul LED', 'LED', 'IONs', 'MODUL BACKUP']);
  assert.equal(ed.transactions[0].action, 'EDIT');
  fail('item.update', { id: MODS[0], name: '' });
  fail('item.update', { id: 'NOPE', name: 'x' });

  const h = ok('history', { itemId: MODS[0] });
  assert.deepEqual(h.transactions.map(t => t.action), ['EDIT', 'KELOMPOK', 'IMPORT']);

  const de = ok('item.deactivate', { ids: [MODS[0], 'NOPE'] });
  assert.equal(de.items.length, 2);
  assert.equal(de.stats.total, 2);
  assert.equal(de.containers[0].itemCount, 0);
  assert.match(de.message, /1 barang/);
  fail('lookup', { code: MODS[0] });
  const dupe = ok('item.import', { type: 'MODUL', name: 'Modul', ids: [MODS[0]] });
  assert.equal(dupe.skippedCount, 1, 'an inactive ID is still taken');
});

test('unknown action and malformed input never crash', () => {
  const { call } = boot();
  assert.equal(call('nope').ok, false);
  assert.equal(call('commit', null).ok, false);
  assert.equal(call('commit', { action: 'KELUAR', ids: 'not,an,array' }).ok, false);
  assert.equal(call('container.assign', { cabinetId: 'x', ids: 42 }).ok, false);
});

test('shared cart: two devices on one login, separate logins, save drops what was saved', () => {
  const { gas, code, ok, fail } = boot();
  ok('item.import', { type: 'MODUL', name: 'Modul', ids: MODS });
  gas.sheets.get('Users').getRange(3, 1, 1, 4).setValues([['Reza', '5555', 'operator', 'TRUE']]);
  const reza = (action, payload = {}) => gas.handle({ user: 'reza', code: '5555', action, payload });

  // bootstrap carries an empty cart; nothing is written until a device changes it
  const first = ok('bootstrap').cart;
  assert.equal(first.rev, 0);
  assert.deepEqual(first.carts, { check: [], out: [], in: [], group: [] });

  // phone A and phone B (same login) add in the same moment: both scans are kept, newest first
  ok('cart.apply', { ops: [{ op: 'add', flow: 'out', items: [{ id: MODS[0], cab: '' }] }] });
  const afterB = ok('cart.apply', { ops: [{ op: 'add', flow: 'out', items: [{ id: MODS[1], cab: '' }, { id: MODS[0], cab: 'BOX-001' }] }] });
  assert.deepEqual(afterB.carts.out, [{ id: MODS[1], cab: '' }, { id: MODS[0], cab: 'BOX-001' }]);
  assert.ok(afterB.rev > first.rev, 'revision grows');

  // the laptop (same login) sees the same cart
  const laptop = ok('cart.get');
  assert.deepEqual(laptop.carts.out.map(e => e.id), [MODS[1], MODS[0]]);
  assert.match(laptop.dataRev, /^\d+\.\d+\.\d+$/);

  // another login has its own, empty cart
  const other = reza('cart.get');
  assert.equal(other.ok, true);
  assert.deepEqual(other.data.carts.out, []);

  // group target, remove, clear
  ok('cart.apply', { ops: [{ op: 'target', id: 'BOX-001' }, { op: 'add', flow: 'group', items: [{ id: MODS[2] }] }] });
  let st = ok('cart.apply', { ops: [{ op: 'remove', flow: 'group', ids: [MODS[2]] }] });
  assert.equal(st.target, 'BOX-001');
  assert.deepEqual(st.carts.group, []);
  ok('cart.apply', { ops: [{ op: 'add', flow: 'check', items: [{ id: MODS[2] }] }, { op: 'clear', flow: 'check' }] });

  // phone saves what it had: saved IDs leave the shared cart, for every device
  const saved = ok('commit', { action: 'KELUAR', ids: [MODS[1], MODS[0]], eventDate: '2026-10-21', location: 'Hall', fromCart: true }, { batchId: 'b-1' });
  assert.deepEqual(saved.cart.carts.out, []);
  assert.deepEqual(ok('cart.get').carts.out, []);

  // the laptop presses Simpan on the same, already-saved cart: nothing is written twice
  const before = gas.rows('Transactions').length;
  const twice = fail('commit', { action: 'KELUAR', ids: [MODS[1], MODS[0]], eventDate: '2026-10-21', location: 'Hall', fromCart: true }, { batchId: 'b-2' });
  assert.match(twice.error, /sudah disimpan/);
  assert.deepEqual(twice.invalid.sort(), [MODS[0], MODS[1]].sort());
  assert.equal(gas.rows('Transactions').length, before);

  // a save without fromCart (old client) still works and ignores the shared cart
  ok('cart.apply', { ops: [{ op: 'add', flow: 'in', items: [{ id: MODS[0] }] }] });
  const plain = ok('commit', { action: 'MASUK', ids: [MODS[0], MODS[1]], eventDate: '2026-10-21', location: 'Hall' }, { batchId: 'b-3' });
  assert.match(plain.message, /2 unit/);
  assert.deepEqual(plain.cart.carts.in, []);

  // only part of the cart left: the rest is saved and the skipped ones are named in the message
  ok('cart.apply', { ops: [{ op: 'add', flow: 'check', items: [{ id: MODS[2] }] }] });
  const part = ok('commit', { action: 'INSPEKSI', ids: [MODS[2], MODS[0]], condition: 'BAIK', fromCart: true }, { batchId: 'b-4' });
  assert.match(part.message, /1 unit\. 1 ID dilewati/);

  // clearing the Carts tab by hand: the next change still gets a newer revision than any device has seen
  const seen = ok('cart.get').rev;
  gas.sheets.get('Carts').getRange(2, 1, 1, 4).setValues([['', '', '', '']]);
  for (const until = Date.now() + 30; Date.now() < until;) { /* real saves are seconds apart; here, a few ms */ }
  const fresh = ok('cart.apply', { ops: [{ op: 'add', flow: 'out', items: [{ id: MODS[0] }] }] });
  assert.ok(fresh.rev > seen, `revision after a manual clear (${fresh.rev}) must exceed ${seen}`);

  // the cart is one readable row per login in the Carts tab
  const rows = gas.rows('Carts').filter(r => r[0]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0][0], 'admin');
  assert.equal(code.length, 6);
});
