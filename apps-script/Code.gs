/** @OnlyCurrentDoc  Asks Google for access to this one spreadsheet only, not all of the owner's. */
/**
 * Inventory Scanner, Apps Script backend.
 *
 * One Google Sheet with five tabs: Items, Containers, Transactions, Users, Carts (open carts per login).
 * The sheet is the database, the admin panel and the backup (version history).
 * This script is its only gatekeeper: it checks the access code, enforces the
 * movement rules, serialises writes with a lock and appends the log.
 *
 * Deploy: Extensions > Apps Script, paste this file, run setup() once,
 * then Deploy > New deployment > Web app, "Execute as: Me", "Who has access: Anyone".
 * The front end POSTs JSON with a text/plain body (a "simple" request, so no CORS preflight):
 *   { user, code, action, payload, batchId }
 * and gets back { ok: true, data } or { ok: false, error, invalid? }.
 */

var VERSION = '2026-10-22';
var TZ = 'Asia/Jakarta';

var TABS = { items: 'Items', containers: 'Containers', transactions: 'Transactions', users: 'Users', carts: 'Carts' };

var ITEM_COLS = ['id', 'qr_value', 'type', 'name', 'category', 'location', 'status', 'condition',
  'damage_note', 'cabinet_id', 'active', 'created_at', 'updated_at', 'last_checked_at', 'last_user'];
var CONTAINER_COLS = ['cabinet_id', 'container_type', 'name', 'category', 'note', 'active', 'created_at', 'updated_at'];
var TXN_COLS = ['ts', 'batch_id', 'action', 'item_id', 'item_name', 'item_type', 'event_date', 'location',
  'event_name', 'cabinet_id', 'condition', 'damage_note', 'note', 'user'];
var USER_COLS = ['name', 'code', 'role', 'active'];
// One row per login: the cart that login's phones and laptops share until Simpan. data is JSON.
var CART_COLS = ['user', 'rev', 'data', 'updated_at'];

var STATUS_IN = 'DI GUDANG';
var STATUS_OUT = 'DI LUAR';
var DEFAULT_LOCATION = 'Gudang';
var FLOW_ACTIONS = ['INSPEKSI', 'KELUAR', 'MASUK'];
var CONTAINER_TYPES = ['KABINET', 'BOX'];
var CONTAINER_PREFIX = { KABINET: 'KAB-', BOX: 'BOX-' };

// The 24 item types of the original app, verbatim.
var ITEM_TYPES = ['MODUL', 'BOX', 'POWER SUPPLY', 'MOBO', 'BRACKET', 'POWER PANEL LISTRIK 3 PHASE', 'PROSESSOR',
  'LIGHTING', 'LIGHTING STAND', 'KABEL JUMPER MALE 120CM', 'KABEL JUMPER BESAR', 'KABEL LAN 120CM',
  'KLEM BUTTERFLY HITAM', 'BAUT HEXAGONE', 'MODUL BACKUP', 'POWER SUPPLY BACKUP', 'MOBO BACKUP', 'REGGING',
  'TOOLS', 'KABEL XLR', 'MIXER LAMPU', 'KABEL LAN PANJANG', 'TRIPOD', 'LIGHT STAND ACCESORIS'];

var ADMIN_ONLY = { 'item.import': true, 'item.update': true, 'item.deactivate': true };
var MUTATING = { 'commit': true, 'item.import': true, 'item.update': true, 'item.deactivate': true,
  'container.save': true, 'container.assign': true, 'container.unassign': true, 'cart.apply': true };
var CART_FLOWS = ['check', 'out', 'in', 'group'];
var FLOW_OF_ACTION = { INSPEKSI: 'check', KELUAR: 'out', MASUK: 'in' };
var MAX_CART = 3000;

var RECENT_TXN = 300;
var MAX_IDS = 2000;
var MAX_FAILED_LOGINS = 10;
var LOCK_WAIT_MS = 30000;

// ---------- entry points ----------

function doGet() {
  return jsonOut({ ok: true, app: 'inventory-scanner', version: VERSION });
}

function doPost(e) {
  var body;
  try {
    body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return jsonOut({ ok: false, error: 'Body bukan JSON.' });
  }
  return jsonOut(handleRequest(body));
}

/** Runs setup from the editor: creates the tabs and the first admin user. */
function setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  ensureTab(ss, TABS.items, ITEM_COLS);
  ensureTab(ss, TABS.containers, CONTAINER_COLS);
  ensureTab(ss, TABS.transactions, TXN_COLS);
  ensureTab(ss, TABS.carts, CART_COLS);
  var users = ensureTab(ss, TABS.users, USER_COLS);
  if (users.getLastRow() < 2) {
    var code = String(Math.floor(100000 + Math.random() * 900000));
    users.getRange(2, 1, 1, USER_COLS.length).setValues([['admin', code, 'admin', 'TRUE']]);
    Logger.log('Admin user created. name=admin code=' + code);
  }
  return 'ok';
}

// ---------- request handling (pure: no HTTP objects, so it can be tested in Node) ----------

var HANDLERS = {
  'bootstrap': hBootstrap,
  'lookup': hLookup,
  'history': hHistory,
  'commit': hCommit,
  'item.import': hItemImport,
  'item.update': hItemUpdate,
  'item.deactivate': hItemDeactivate,
  'container.nextId': hContainerNextId,
  'container.save': hContainerSave,
  'container.assign': hContainerAssign,
  'container.unassign': hContainerUnassign,
  'cart.get': hCartGet,
  'cart.apply': hCartApply
};

function handleRequest(body) {
  try {
    body = body || {};
    var action = str(body.action);
    var handler = HANDLERS[action];
    if (!handler) throw new AppError('Aksi tidak dikenal: ' + action);
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var user = authenticate(ss, body.user, body.code);
    if (ADMIN_ONLY[action] && user.role !== 'admin') throw new AppError('Hanya admin yang boleh melakukan ini.');
    var payload = body.payload || {};
    var batchId = str(body.batchId);
    if (MUTATING[action]) {
      var cache = CacheService.getScriptCache();
      if (batchId && cache.get('batch:' + batchId)) {
        return { ok: true, repeated: true, data: withMessage(snapshot(ss), 'Sudah tersimpan sebelumnya.') };
      }
      var result = withLock(function () { return handler(ss, payload, user, batchId); });
      if (batchId) cache.put('batch:' + batchId, '1', 21600);
      return { ok: true, data: result };
    }
    return { ok: true, data: handler(ss, payload, user, batchId) };
  } catch (err) {
    if (err instanceof AppError) return { ok: false, error: err.message, invalid: err.invalid || [] };
    return { ok: false, error: 'Kesalahan server: ' + (err && err.message ? err.message : String(err)) };
  }
}

function AppError(message, invalid) {
  this.name = 'AppError';
  this.message = message;
  this.invalid = invalid || [];
}
AppError.prototype = Object.create(Error.prototype);

// ---------- auth ----------

function authenticate(ss, name, code) {
  name = str(name);
  code = str(code);
  if (!name || !code) throw new AppError('Nama dan kode akses wajib diisi.');
  var cache = CacheService.getScriptCache();
  var failKey = 'fail:' + name.toLowerCase();
  var failed = Number(cache.get(failKey) || 0);
  if (failed >= MAX_FAILED_LOGINS) throw new AppError('Terlalu banyak percobaan. Coba lagi dalam 10 menit.');
  var users = readTable(ss, TABS.users, USER_COLS).rows;
  for (var i = 0; i < users.length; i++) {
    var u = users[i];
    if (u.name.toLowerCase() === name.toLowerCase() && u.code === code && isTrue(u.active)) {
      return { name: u.name, role: u.role.toLowerCase() === 'admin' ? 'admin' : 'operator' };
    }
  }
  cache.put(failKey, String(failed + 1), 600);
  throw new AppError('Nama atau kode akses salah.');
}

// ---------- handlers ----------

function hBootstrap(ss, payload, user) {
  var snap = snapshot(ss);
  snap.me = user;
  snap.version = VERSION;
  snap.types = ITEM_TYPES;
  snap.containerTypes = CONTAINER_TYPES;
  snap.cart = publicCart(ss, loadCart(ss, user).state);
  return snap;
}

/** Resolves a scanned code to an item, a container, or both (a box label can be both). */
function hLookup(ss, payload) {
  var code = str(payload.code);
  if (!code) throw new AppError('Kode kosong.');
  var items = activeRows(readTable(ss, TABS.items, ITEM_COLS).rows);
  var containers = activeRows(readTable(ss, TABS.containers, CONTAINER_COLS).rows);
  var item = findItem(items, code);
  var container = findContainer(containers, code);
  if (!item && !container) throw new AppError('Kode tidak ditemukan pada inventaris aktif: ' + code);
  var members = container ? items.filter(function (x) { return x.cabinet_id === container.cabinet_id; }) : [];
  return { item: item ? publicItem(item) : null, container: container ? publicContainer(container, items) : null,
    members: members.map(publicItem) };
}

function hHistory(ss, payload) {
  var itemId = str(payload.itemId);
  if (!itemId) throw new AppError('ID kosong.');
  var rows = readTable(ss, TABS.transactions, TXN_COLS).rows;
  var out = [];
  for (var i = rows.length - 1; i >= 0 && out.length < 500; i--) {
    if (rows[i].item_id.toLowerCase() === itemId.toLowerCase()) out.push(rows[i]);
  }
  return { itemId: itemId, transactions: out };
}

function hCommit(ss, payload, user, batchId) {
  var action = str(payload.action).toUpperCase();
  if (FLOW_ACTIONS.indexOf(action) < 0) throw new AppError('Tindakan tidak dikenal: ' + action);
  var ids = cleanIds(payload.ids);
  if (!ids.length) throw new AppError('Keranjang kosong.');
  var flowKey = FLOW_OF_ACTION[action];
  var skippedNote = '';
  if (payload.fromCart === true) {
    // Two devices on one login can both press Simpan; only what is still in the shared cart is saved.
    var shared = loadCart(ss, user);
    if (shared.row) {
      var inCart = {};
      shared.state.carts[flowKey].forEach(function (e) { inCart[e.id.toLowerCase()] = true; });
      var gone = ids.filter(function (id) { return !inCart[id.toLowerCase()]; });
      if (gone.length === ids.length) throw new AppError('Keranjang ini sudah disimpan atau dikosongkan dari perangkat lain.', gone);
      if (gone.length) skippedNote = ' ' + gone.length + ' ID dilewati karena sudah tidak ada di keranjang.';
      ids = ids.filter(function (id) { return inCart[id.toLowerCase()]; });
    }
  }

  var table = readTable(ss, TABS.items, ITEM_COLS);
  var byId = indexItems(table.rows);
  var missing = ids.filter(function (id) { return !byId[id.toLowerCase()] || !isTrue(byId[id.toLowerCase()].active); });
  if (missing.length) throw new AppError('ID tidak ditemukan pada inventaris aktif: ' + missing.join(', '), missing);

  var now = nowStr();
  var txnFields = { event_date: '', location: '', event_name: '', condition: '', damage_note: '', note: str(payload.note) };

  if (action === 'INSPEKSI') {
    var condition = str(payload.condition).toUpperCase();
    if (condition !== 'BAIK' && condition !== 'RUSAK') throw new AppError('Hasil pemeriksaan harus BAIK atau RUSAK.');
    var damageNote = str(payload.damageNote);
    if (condition === 'RUSAK' && !damageNote) throw new AppError('Keterangan kerusakan wajib diisi.');
    txnFields.condition = condition;
    txnFields.damage_note = condition === 'RUSAK' ? damageNote : '';
    txnFields.event_date = str(payload.eventDate) || now.slice(0, 10);
  } else {
    txnFields.event_date = str(payload.eventDate);
    txnFields.location = str(payload.location);
    txnFields.event_name = str(payload.eventName);
    if (!txnFields.event_date) throw new AppError('Tanggal wajib diisi.');
    if (!txnFields.location) throw new AppError('Lokasi wajib diisi.');
    var wrongStatus = action === 'KELUAR' ? STATUS_OUT : STATUS_IN;
    var invalid = ids.filter(function (id) { return byId[id.toLowerCase()].status === wrongStatus; });
    if (invalid.length) {
      var why = action === 'KELUAR' ? 'sudah DI LUAR, tidak bisa dikeluarkan lagi' : 'masih DI GUDANG, tidak bisa diproses masuk';
      throw new AppError(invalid.length + ' barang ' + why + ': ' + invalid.join(', '), invalid);
    }
  }

  var storeLocation = str(payload.storeLocation) || DEFAULT_LOCATION;
  var txns = [];
  ids.forEach(function (id) {
    var item = byId[id.toLowerCase()];
    if (action === 'KELUAR') { item.status = STATUS_OUT; item.location = txnFields.location; }
    if (action === 'MASUK') { item.status = STATUS_IN; item.location = storeLocation; }
    if (action === 'INSPEKSI') { item.condition = txnFields.condition; item.damage_note = txnFields.damage_note; item.last_checked_at = now; }
    item.updated_at = now;
    item.last_user = user.name;
    txns.push(txnRow(now, batchId, action, item, txnFields, user));
  });
  writeTable(table, ITEM_COLS);
  appendRows(ss, TABS.transactions, TXN_COLS, txns);

  var cartState = dropFromCart(ss, user, flowKey, ids);
  var verb = { INSPEKSI: 'Pengecekan', KELUAR: 'Barang keluar', MASUK: 'Barang masuk' }[action];
  var snap = withMessage(snapshot(ss), verb + ' tersimpan untuk ' + ids.length + ' unit.' + skippedNote);
  if (cartState) snap.cart = publicCart(ss, cartState);
  return snap;
}

function hItemImport(ss, payload, user, batchId) {
  var type = str(payload.type).toUpperCase();
  var name = str(payload.name);
  if (!type) throw new AppError('Jenis barang wajib diisi.');
  if (!name) throw new AppError('Nama barang wajib diisi.');
  var ids = splitIds(payload.ids); // duplicates inside the pasted list are reported as skipped, not silently merged
  if (!ids.length) throw new AppError('Tempelkan minimal satu ID.');
  if (ids.length > MAX_IDS) throw new AppError('Maksimal ' + MAX_IDS + ' ID per proses.');

  var table = readTable(ss, TABS.items, ITEM_COLS);
  var byId = indexItems(table.rows);
  var now = nowStr();
  var added = [], skipped = [], txns = [];
  ids.forEach(function (id) {
    if (byId[id.toLowerCase()]) { skipped.push(id); return; }
    var item = { id: id, qr_value: id, type: type, name: name, category: str(payload.category),
      location: str(payload.location) || DEFAULT_LOCATION, status: STATUS_IN, condition: '', damage_note: '',
      cabinet_id: '', active: 'TRUE', created_at: now, updated_at: now, last_checked_at: '', last_user: user.name };
    byId[id.toLowerCase()] = item;
    table.rows.push(item);
    added.push(id);
    txns.push(txnRow(now, batchId, 'IMPORT', item, { note: 'Didaftarkan' }, user));
  });
  if (added.length) {
    writeTable(table, ITEM_COLS);
    appendRows(ss, TABS.transactions, TXN_COLS, txns);
  }
  var snap = withMessage(snapshot(ss), added.length + ' ID ditambahkan' + (skipped.length ? ', ' + skipped.length + ' duplikat dilewati.' : '.'));
  snap.addedCount = added.length;
  snap.skippedCount = skipped.length;
  snap.skipped = skipped.slice(0, 100);
  return snap;
}

function hItemUpdate(ss, payload, user, batchId) {
  var id = str(payload.id);
  var table = readTable(ss, TABS.items, ITEM_COLS);
  var item = indexItems(table.rows)[id.toLowerCase()];
  if (!item || !isTrue(item.active)) throw new AppError('Barang tidak ditemukan: ' + id);
  var changes = [];
  ['name', 'category', 'location', 'type'].forEach(function (f) {
    if (payload[f] === undefined || payload[f] === null) return;
    var v = f === 'type' ? str(payload[f]).toUpperCase() : str(payload[f]);
    if (f === 'name' && !v) throw new AppError('Nama barang wajib diisi.');
    if (f === 'type' && !v) return;
    if (v !== item[f]) { changes.push(f + ': ' + item[f] + ' -> ' + v); item[f] = v; }
  });
  if (!changes.length) return withMessage(snapshot(ss), 'Tidak ada perubahan.');
  var now = nowStr();
  item.updated_at = now;
  item.last_user = user.name;
  writeTable(table, ITEM_COLS);
  appendRows(ss, TABS.transactions, TXN_COLS, [txnRow(now, batchId, 'EDIT', item, { note: changes.join('; ') }, user)]);
  return withMessage(snapshot(ss), 'Barang ' + id + ' diperbarui.');
}

function hItemDeactivate(ss, payload, user, batchId) {
  var ids = cleanIds(payload.ids);
  if (!ids.length) throw new AppError('Pilih barang yang dinonaktifkan.');
  var table = readTable(ss, TABS.items, ITEM_COLS);
  var byId = indexItems(table.rows);
  var now = nowStr(), txns = [], count = 0;
  ids.forEach(function (id) {
    var item = byId[id.toLowerCase()];
    if (!item || !isTrue(item.active)) return;
    item.active = 'FALSE';
    item.cabinet_id = '';
    item.updated_at = now;
    item.last_user = user.name;
    txns.push(txnRow(now, batchId, 'NONAKTIF', item, { note: str(payload.note) || 'Dinonaktifkan' }, user));
    count++;
  });
  if (count) {
    writeTable(table, ITEM_COLS);
    appendRows(ss, TABS.transactions, TXN_COLS, txns);
  }
  return withMessage(snapshot(ss), count + ' barang dinonaktifkan. Riwayatnya tetap tersimpan.');
}

function hContainerNextId(ss, payload) {
  var type = str(payload.containerType).toUpperCase();
  if (CONTAINER_TYPES.indexOf(type) < 0) throw new AppError('Jenis wadah harus KABINET atau BOX.');
  return { cabinetId: nextContainerId(readTable(ss, TABS.containers, CONTAINER_COLS).rows, type) };
}

/** Creates a container (auto ID, or a custom ID such as the physical box label) or edits an existing one. */
function hContainerSave(ss, payload, user, batchId) {
  var table = readTable(ss, TABS.containers, CONTAINER_COLS);
  var name = str(payload.name);
  if (!name) throw new AppError('Nama kabinet/box wajib diisi.');
  var now = nowStr();
  var requestedId = str(payload.cabinetId);
  var existing = requestedId ? findContainer(table.rows, requestedId) : null;
  var cabinetId;
  if (existing && !payload.createNew) {
    existing.name = name;
    existing.category = str(payload.category);
    existing.note = str(payload.note);
    existing.active = 'TRUE';
    existing.updated_at = now;
    cabinetId = existing.cabinet_id;
  } else {
    if (existing) throw new AppError('ID sudah dipakai: ' + requestedId);
    var type = str(payload.containerType).toUpperCase();
    if (CONTAINER_TYPES.indexOf(type) < 0) throw new AppError('Jenis wadah harus KABINET atau BOX.');
    cabinetId = requestedId || nextContainerId(table.rows, type);
    if (!/^[A-Za-z0-9._\-\/]{1,50}$/.test(cabinetId)) throw new AppError('ID wadah hanya boleh huruf, angka, titik, strip dan garis miring (maks. 50).');
    table.rows.push({ cabinet_id: cabinetId, container_type: type, name: name, category: str(payload.category),
      note: str(payload.note), active: 'TRUE', created_at: now, updated_at: now });
  }
  writeTable(table, CONTAINER_COLS);
  var snap = withMessage(snapshot(ss), (existing && !payload.createNew ? 'Wadah diperbarui: ' : 'Wadah dibuat: ') + cabinetId);
  snap.cabinetId = cabinetId;
  return snap;
}

function hContainerAssign(ss, payload, user, batchId) {
  var cabinetId = str(payload.cabinetId);
  var ids = cleanIds(payload.ids);
  if (!cabinetId) throw new AppError('Pilih kabinet/box tujuan.');
  if (!ids.length) throw new AppError('Pilih atau scan minimal satu aset.');
  var containers = readTable(ss, TABS.containers, CONTAINER_COLS).rows;
  var container = findContainer(activeRows(containers), cabinetId);
  if (!container) throw new AppError('Kabinet/box tidak ditemukan: ' + cabinetId);
  var table = readTable(ss, TABS.items, ITEM_COLS);
  var byId = indexItems(table.rows);
  var missing = ids.filter(function (id) { return !byId[id.toLowerCase()] || !isTrue(byId[id.toLowerCase()].active); });
  if (missing.length) throw new AppError('ID tidak ditemukan pada inventaris aktif: ' + missing.join(', '), missing);
  var now = nowStr(), txns = [], moved = 0;
  ids.forEach(function (id) {
    var item = byId[id.toLowerCase()];
    if (item.cabinet_id === container.cabinet_id) return;
    var from = item.cabinet_id;
    item.cabinet_id = container.cabinet_id;
    item.updated_at = now;
    item.last_user = user.name;
    txns.push(txnRow(now, batchId, 'KELOMPOK', item, { note: from ? 'Dipindah dari ' + from : 'Masuk wadah' }, user));
    moved++;
  });
  if (moved) {
    writeTable(table, ITEM_COLS);
    appendRows(ss, TABS.transactions, TXN_COLS, txns);
  }
  var cartState = dropFromCart(ss, user, 'group', ids);
  var snap = withMessage(snapshot(ss), moved + ' aset masuk ke ' + container.cabinet_id + '.');
  if (cartState) snap.cart = publicCart(ss, cartState);
  return snap;
}

function hContainerUnassign(ss, payload, user, batchId) {
  var ids = cleanIds(payload.ids);
  if (!ids.length) throw new AppError('Pilih aset yang dilepas.');
  var table = readTable(ss, TABS.items, ITEM_COLS);
  var byId = indexItems(table.rows);
  var now = nowStr(), txns = [], count = 0;
  ids.forEach(function (id) {
    var item = byId[id.toLowerCase()];
    if (!item || !isTrue(item.active) || !item.cabinet_id) return;
    var from = item.cabinet_id;
    item.cabinet_id = '';
    item.updated_at = now;
    item.last_user = user.name;
    var row = txnRow(now, batchId, 'LEPAS', item, { note: 'Dilepas dari ' + from }, user);
    row[TXN_COLS.indexOf('cabinet_id')] = from;
    txns.push(row);
    count++;
  });
  if (count) {
    writeTable(table, ITEM_COLS);
    appendRows(ss, TABS.transactions, TXN_COLS, txns);
  }
  var cartState = dropFromCart(ss, user, 'group', ids);
  var snap = withMessage(snapshot(ss), count + ' aset dilepas dari wadahnya.');
  if (cartState) snap.cart = publicCart(ss, cartState);
  return snap;
}

// ---------- shared cart: every device on one login sees the same cart ----------
// Devices send small operations ("add this ID", "remove", "clear"), never a whole cart, so two phones
// scanning in the same second both keep their scans. Simpan removes the saved IDs for every device.

function hCartGet(ss, payload, user) {
  return publicCart(ss, loadCart(ss, user).state);
}

function hCartApply(ss, payload, user) {
  var ops = Array.isArray(payload.ops) ? payload.ops : [];
  if (ops.length > 1000) throw new AppError('Terlalu banyak perubahan sekaligus.');
  var c = loadCart(ss, user);
  ops.forEach(function (op) { applyCartOp(c.state, op || {}); });
  saveCart(ss, c, user);
  return publicCart(ss, c.state);
}

function emptyCarts() { return { check: [], out: [], in: [], group: [] }; }

function loadCart(ss, user) {
  var sheet = ss.getSheetByName(TABS.carts);
  var table = sheet ? readTable(ss, TABS.carts, CART_COLS) : { sheet: null, rows: [] };
  var key = user.name.toLowerCase(), row = null;
  for (var i = 0; i < table.rows.length; i++) if (table.rows[i].user.toLowerCase() === key) { row = table.rows[i]; break; }
  var st = { rev: 0, carts: emptyCarts(), target: '' };
  if (row) {
    st.rev = Number(row.rev) || 0;
    var d = {};
    try { d = JSON.parse(row.data || '{}') || {}; } catch (e) { d = {}; }
    CART_FLOWS.forEach(function (f) {
      var list = d.carts && Array.isArray(d.carts[f]) ? d.carts[f] : [];
      st.carts[f] = list.filter(function (e) { return e && str(e.id); }).map(function (e) { return { id: str(e.id), cab: str(e.cab) }; });
    });
    st.target = str(d.target);
  }
  return { table: table, row: row, state: st };
}

function saveCart(ss, c, user) {
  c.state.rev++;
  var data = JSON.stringify({ carts: c.state.carts, target: c.state.target });
  if (data.length > 45000) throw new AppError('Keranjang terlalu besar. Simpan sebagian dulu.');
  var values = [user.name, String(c.state.rev), data, nowStr()];
  if (c.row) {
    c.table.sheet.getRange(c.row._row, 1, 1, CART_COLS.length).setValues([values]);
  } else {
    if (!ss.getSheetByName(TABS.carts)) ensureTab(ss, TABS.carts, CART_COLS);
    appendRows(ss, TABS.carts, CART_COLS, [values]);
  }
}

function applyCartOp(st, op) {
  var kind = str(op.op), f = str(op.flow);
  if (kind === 'target') { st.target = str(op.id); return; }
  if (CART_FLOWS.indexOf(f) < 0) return;
  if (kind === 'clear') { st.carts[f] = []; return; }
  if (kind === 'remove') {
    var gone = {};
    cleanIds(op.ids).forEach(function (id) { gone[id.toLowerCase()] = true; });
    st.carts[f] = st.carts[f].filter(function (e) { return !gone[e.id.toLowerCase()]; });
    return;
  }
  if (kind === 'add') {
    var cart = st.carts[f];
    (Array.isArray(op.items) ? op.items : []).forEach(function (e) {
      var id = str(e && e.id);
      if (!id) return;
      var cab = str(e.cab);
      for (var i = 0; i < cart.length; i++) {
        if (cart[i].id.toLowerCase() === id.toLowerCase()) { if (cab) cart[i].cab = cab; return; }
      }
      if (cart.length >= MAX_CART) throw new AppError('Keranjang penuh (' + MAX_CART + ' unit). Simpan dulu.');
      cart.unshift({ id: id, cab: cab });
    });
  }
}

/** After a save: the saved IDs leave this login's shared cart. Returns the new state, or null if there is no cart. */
function dropFromCart(ss, user, flowKey, ids) {
  var c = loadCart(ss, user);
  if (!c.row) return null;
  var before = c.state.carts[flowKey].length;
  applyCartOp(c.state, { op: 'remove', flow: flowKey, ids: ids });
  if (c.state.carts[flowKey].length !== before) saveCart(ss, c, user);
  return c.state;
}

function publicCart(ss, st) {
  return { rev: st.rev, carts: st.carts, target: st.target, dataRev: dataRev(ss) };
}

/** Changes whenever a save adds rows anywhere, so an idle laptop knows to re-read the sheet. */
function dataRev(ss) {
  return [TABS.items, TABS.containers, TABS.transactions].map(function (n) {
    var sh = ss.getSheetByName(n);
    return sh ? sh.getLastRow() : 0;
  }).join('.');
}

// ---------- snapshot and stats ----------

function snapshot(ss) {
  var items = activeRows(readTable(ss, TABS.items, ITEM_COLS).rows);
  var containers = activeRows(readTable(ss, TABS.containers, CONTAINER_COLS).rows);
  var txns = readTable(ss, TABS.transactions, TXN_COLS).rows;
  var recent = txns.slice(Math.max(0, txns.length - RECENT_TXN)).reverse();
  var stats = { total: items.length, good: 0, damaged: 0, unchecked: 0, out: 0, inWarehouse: 0, boxes: containers.length };
  items.forEach(function (x) {
    if (x.condition === 'BAIK') stats.good++; else if (x.condition === 'RUSAK') stats.damaged++; else stats.unchecked++;
    if (x.status === STATUS_OUT) stats.out++; else stats.inWarehouse++;
  });
  return {
    items: items.map(publicItem),
    containers: containers.map(function (c) { return publicContainer(c, items); }),
    stats: stats,
    transactions: recent,
    dataRev: dataRev(ss),
    generatedAt: nowStr()
  };
}

function publicItem(x) {
  return { id: x.id, qrValue: x.qr_value, type: x.type, name: x.name, category: x.category, location: x.location,
    locationStatus: x.status || STATUS_IN, condition: x.condition, damageNote: x.damage_note, cabinetId: x.cabinet_id,
    updatedAt: x.updated_at, lastCheckedAt: x.last_checked_at, lastUser: x.last_user };
}

function publicContainer(c, items) {
  var itemCount = 0, damagedCount = 0, outCount = 0;
  items.forEach(function (x) {
    if (x.cabinet_id !== c.cabinet_id) return;
    itemCount++;
    if (x.condition === 'RUSAK') damagedCount++;
    if (x.status === STATUS_OUT) outCount++;
  });
  return { cabinetId: c.cabinet_id, containerType: c.container_type, name: c.name, category: c.category, note: c.note,
    itemCount: itemCount, damagedCount: damagedCount, outCount: outCount };
}

function withMessage(snap, message) { snap.message = message; return snap; }

// ---------- sheet access ----------

function ensureTab(ss, name, cols) {
  var sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  var header = sheet.getRange(1, 1, 1, cols.length);
  var current = header.getValues()[0].map(str);
  var same = current.length === cols.length && current.every(function (v, i) { return v === cols[i]; });
  if (!same) {
    if (sheet.getLastRow() > 0 && current.join('') !== '') {
      throw new Error('Tab "' + name + '" sudah ada dengan kolom berbeda. Ganti nama tab lama dulu.');
    }
    header.setValues([cols]);
  }
  header.setFontWeight('bold');
  sheet.setFrozenRows(1);
  // Everything as plain text, so IDs, dates and codes come back exactly as written.
  sheet.getRange(1, 1, sheet.getMaxRows(), sheet.getMaxColumns()).setNumberFormat('@');
  return sheet;
}

/** Reads a tab into objects keyed by header name. Missing tab = error that names setup(). */
function readTable(ss, name, cols) {
  var sheet = ss.getSheetByName(name);
  if (!sheet) throw new AppError('Tab "' + name + '" belum ada. Jalankan setup() di Apps Script.');
  var lastRow = sheet.getLastRow();
  var rows = [];
  if (lastRow >= 2) {
    var values = sheet.getRange(2, 1, lastRow - 1, cols.length).getValues();
    for (var i = 0; i < values.length; i++) {
      var obj = {};
      var empty = true;
      for (var c = 0; c < cols.length; c++) {
        obj[cols[c]] = cell(values[i][c]);
        if (obj[cols[c]] !== '') empty = false;
      }
      obj._row = i + 2;
      if (!empty) rows.push(obj);
    }
  }
  return { sheet: sheet, rows: rows };
}

/** Rewrites every data row of a tab. Tables here are small (hundreds of rows). */
function writeTable(table, cols) {
  var sheet = table.sheet;
  var lastRow = sheet.getLastRow();
  if (lastRow >= 2) sheet.getRange(2, 1, lastRow - 1, cols.length).clearContent();
  if (!table.rows.length) return;
  var values = table.rows.map(function (r) { return cols.map(function (c) { return r[c] === undefined ? '' : r[c]; }); });
  sheet.getRange(2, 1, values.length, cols.length).setValues(values);
}

function appendRows(ss, name, cols, rows) {
  if (!rows.length) return;
  var sheet = ss.getSheetByName(name);
  if (!sheet) throw new AppError('Tab "' + name + '" belum ada. Jalankan setup() di Apps Script.');
  var start = sheet.getLastRow() + 1;
  sheet.getRange(start, 1, rows.length, cols.length).setValues(rows);
}

function txnRow(ts, batchId, action, item, f, user) {
  f = f || {};
  return [ts, batchId || '', action, item.id, item.name, item.type, str(f.event_date), str(f.location), str(f.event_name),
    item.cabinet_id || '', str(f.condition), str(f.damage_note), str(f.note), user.name];
}

function withLock(fn) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_WAIT_MS)) throw new AppError('Server sedang sibuk, coba lagi.');
  try { return fn(); } finally { lock.releaseLock(); }
}

// ---------- helpers ----------

function str(v) {
  if (v === null || v === undefined) return '';
  return String(v).trim();
}

function cell(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return Utilities.formatDate(v, TZ, 'yyyy-MM-dd HH:mm:ss');
  return String(v).trim();
}

function isTrue(v) { return str(v).toUpperCase() === 'TRUE'; }

function nowStr() { return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm:ss'); }

function activeRows(rows) { return rows.filter(function (r) { return isTrue(r.active); }); }

function indexItems(rows) {
  var byId = {};
  rows.forEach(function (r) { if (r.id) byId[r.id.toLowerCase()] = r; });
  return byId;
}

function findItem(items, code) {
  var k = code.toLowerCase();
  for (var i = 0; i < items.length; i++) {
    if (items[i].id.toLowerCase() === k || (items[i].qr_value && items[i].qr_value.toLowerCase() === k)) return items[i];
  }
  return null;
}

function findContainer(containers, code) {
  var k = code.toLowerCase();
  for (var i = 0; i < containers.length; i++) if (containers[i].cabinet_id.toLowerCase() === k) return containers[i];
  return null;
}

function splitIds(list) {
  if (typeof list === 'string') list = list.split(/[\n\r\t,;]+/);
  if (!Array.isArray(list)) return [];
  return list.map(str).filter(function (id) { return !!id; });
}

function cleanIds(list) {
  var seen = {}, out = [];
  splitIds(list).forEach(function (id) {
    if (seen[id.toLowerCase()]) return;
    seen[id.toLowerCase()] = true;
    out.push(id);
  });
  return out;
}

function nextContainerId(rows, type) {
  var prefix = CONTAINER_PREFIX[type];
  var max = 0;
  rows.forEach(function (r) {
    if (r.container_type !== type) return;
    var m = new RegExp('^' + prefix + '(\\d+)$', 'i').exec(r.cabinet_id);
    if (m) max = Math.max(max, Number(m[1]));
  });
  var n = String(max + 1);
  while (n.length < 3) n = '0' + n;
  return prefix + n;
}

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
