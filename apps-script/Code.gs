/** @OnlyCurrentDoc  Asks Google for access to this one spreadsheet only, not all of the owner's. */
/**
 * Inventory Scanner, Apps Script backend.
 *
 * One Google Sheet with seven tabs: Items, Storage, Transactions, Users, Carts (open carts per login),
 * Lists (categories, sub-categories, storage places and storage types, which the team edits itself) and
 * Impor (rows pasted from an old list, added in bulk from the sheet's Inventaris menu).
 * The sheet is the database, the admin panel and the backup (version history).
 * This script is its only gatekeeper: it checks the access code, enforces the movement rules, creates the
 * item codes, serialises writes with a lock and appends the log.
 *
 * Deploy: Extensions > Apps Script, paste this file, run setup() once (again after an update that adds
 * columns), then Deploy > New deployment > Web app, "Execute as: Me", "Who has access: Anyone".
 * The front end POSTs JSON as text/plain (a "simple" request, so no CORS preflight):
 *   { user, code, action, payload, batchId }
 * and gets back { ok: true, data } or { ok: false, error, invalid? }.
 */

var VERSION = '2026-10-28';
var TZ = 'Asia/Jakarta';

var TABS = { items: 'Items', storage: 'Storage', transactions: 'Transactions', users: 'Users', carts: 'Carts', lists: 'Lists',
  imports: 'Impor' };

// One row per unit. location is a storage place (Storage, Drybox, ...) or On Duty while it is out; destination
// is where its last check-out went; status is Active or Passive; active = FALSE means removed from the inventory.
var ITEM_COLS = ['id', 'qr_value', 'category', 'subcategory', 'brand', 'model', 'serial', 'location', 'destination',
  'status', 'condition', 'condition_note', 'note', 'storage_id', 'active', 'created_at', 'updated_at', 'last_checked_at', 'last_user'];
var STORAGE_COLS = ['storage_id', 'storage_type', 'name', 'category', 'note', 'active', 'created_at', 'updated_at'];
var TXN_COLS = ['ts', 'batch_id', 'action', 'item_id', 'item_name', 'category', 'event_date', 'from', 'to', 'storage_id',
  'condition', 'status', 'note', 'user'];
var USER_COLS = ['name', 'code', 'role', 'active'];
// One row per login: the cart that login's phones and laptops share until Simpan. data is JSON.
var CART_COLS = ['user', 'rev', 'data', 'updated_at'];
// One row per choice. list is kategori, subkategori, lokasi or wadah; code is the short code used in item and
// storage IDs; parent ties a sub-category to its category. Add or rename rows here; the app reads them at login.
var LIST_COLS = ['list', 'value', 'code', 'parent'];
// One row per unit to add. cek holds a question for a person: the row waits until it is cleared. kode and hasil
// are written by the import; a row with a kode is done and never added twice.
var IMPORT_COLS = ['baris_lama', 'category', 'subcategory', 'brand', 'model', 'serial', 'location', 'condition',
  'condition_note', 'status', 'note', 'cek', 'kode', 'hasil'];

var ON_DUTY = 'On Duty';
var CONDITIONS = ['Good', 'Need Maintenance', 'Broken', 'Untested'];
var NEEDS_NOTE = { 'Need Maintenance': true, 'Broken': true };
var STATUSES = ['Active', 'Passive'];
var FLOW_ACTIONS = ['INSPEKSI', 'KELUAR', 'MASUK'];

// Bagas's "Format Inventaris Alat Media" (26 Okt 2026). Codes are proposals; the team corrects them in Lists.
var DEFAULT_LISTS = [
  ['kategori', 'Kamera', 'KM', ''], ['kategori', 'Lensa', 'LN', ''], ['kategori', 'Lighting', 'LG', ''],
  ['kategori', 'Camera Support & Accessories', 'CS', ''], ['kategori', 'Multimedia & Lainnya', 'ML', ''],
  ['subkategori', 'CANON Camera', 'CAN', 'Kamera'], ['subkategori', 'SONY Camera', 'SON', 'Kamera'],
  ['subkategori', 'NIKON Camera', 'NIK', 'Kamera'], ['subkategori', 'Aerial', 'AER', 'Kamera'],
  ['subkategori', 'Camcorder', 'CCD', 'Kamera'], ['subkategori', 'Action & Underwater', 'ACT', 'Kamera'],
  ['subkategori', 'Z Mount', 'ZMT', 'Lensa'], ['subkategori', 'E Mount', 'EMT', 'Lensa'],
  ['subkategori', 'RF Mount', 'RFM', 'Lensa'], ['subkategori', 'Other Mount', 'OTM', 'Lensa'],
  ['subkategori', 'Godox', 'GDX', 'Lighting'], ['subkategori', 'Aputure', 'APT', 'Lighting'],
  ['subkategori', 'Flash Light', 'FLS', 'Lighting'], ['subkategori', 'Lighting Support', 'LSP', 'Lighting'],
  ['subkategori', 'Adapter & Converter', 'ADP', 'Camera Support & Accessories'],
  ['subkategori', 'Battery & Charger', 'BAT', 'Camera Support & Accessories'],
  ['subkategori', 'Cable / Kabel', 'CBL', 'Camera Support & Accessories'],
  ['subkategori', 'Filter', 'FLT', 'Camera Support & Accessories'],
  ['subkategori', 'GoPro Accessories', 'GPA', 'Camera Support & Accessories'],
  ['subkategori', 'Grip & Textile', 'GRP', 'Camera Support & Accessories'],
  ['subkategori', 'Laptop / Computer', 'LPT', 'Camera Support & Accessories'],
  ['subkategori', 'Memory', 'MEM', 'Camera Support & Accessories'],
  ['subkategori', 'Photo Support', 'PHS', 'Camera Support & Accessories'],
  ['subkategori', 'Reflector', 'RFL', 'Camera Support & Accessories'],
  ['subkategori', 'RIG & Camera Stabilizer', 'RIG', 'Camera Support & Accessories'],
  ['subkategori', 'Slider', 'SLD', 'Camera Support & Accessories'],
  ['subkategori', 'Tripod & Monopod', 'TRP', 'Camera Support & Accessories'],
  ['subkategori', 'Switcher & Recorder', 'SWR', 'Multimedia & Lainnya'],
  ['subkategori', 'Audio', 'AUD', 'Multimedia & Lainnya'],
  ['subkategori', 'Display', 'DSP', 'Multimedia & Lainnya'],
  ['lokasi', 'Storage', '', ''], ['lokasi', 'Drybox', '', ''],
  ['wadah', 'Pouch', 'POU', ''], ['wadah', 'Tas', 'TAS', ''], ['wadah', 'Koper', 'KOP', ''], ['wadah', 'Kontainer', 'KON', '']
];

var ADMIN_ONLY = { 'item.add': true, 'item.update': true, 'item.deactivate': true };
var MUTATING = { 'commit': true, 'item.add': true, 'item.update': true, 'item.deactivate': true,
  'storage.save': true, 'storage.assign': true, 'storage.unassign': true, 'cart.apply': true };
var CART_FLOWS = ['check', 'out', 'in', 'group'];
var FLOW_OF_ACTION = { INSPEKSI: 'check', KELUAR: 'out', MASUK: 'in' };
var MAX_CART = 3000;

var RECENT_TXN = 300;
var MAX_IDS = 2000;
var MAX_QUANTITY = 200;
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

/** Creates or updates the tabs. Safe to run again: tabs that hold data are never rewritten. */
function setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  // Before 28 Okt 2026 the sheet had the LED-screen columns. Tabs of that version that hold data are kept
  // under a new name, so nothing is lost and fresh tabs take the media columns. An empty Containers tab
  // simply becomes Storage. Any other tab with data and other columns still stops setup (see ensureTab).
  keepLegacyTab(ss, TABS.items, 'cabinet_id');
  keepLegacyTab(ss, TABS.transactions, 'item_type');
  keepLegacyTab(ss, 'Containers', 'cabinet_id');
  var old = ss.getSheetByName('Containers');
  if (old && !ss.getSheetByName(TABS.storage) && old.getLastRow() <= 1) old.setName(TABS.storage);
  ensureTab(ss, TABS.items, ITEM_COLS);
  ensureTab(ss, TABS.storage, STORAGE_COLS);
  ensureTab(ss, TABS.transactions, TXN_COLS);
  ensureTab(ss, TABS.carts, CART_COLS);
  var lists = ensureTab(ss, TABS.lists, LIST_COLS);
  if (lists.getLastRow() < 2) lists.getRange(2, 1, DEFAULT_LISTS.length, LIST_COLS.length).setValues(DEFAULT_LISTS);
  var users = ensureTab(ss, TABS.users, USER_COLS);
  if (users.getLastRow() < 2) {
    var code = String(Math.floor(100000 + Math.random() * 900000));
    users.getRange(2, 1, 1, USER_COLS.length).setValues([['admin', code, 'admin', 'TRUE']]);
    Logger.log('Admin user created. name=admin code=' + code);
  }
  ensureTab(ss, TABS.imports, IMPORT_COLS);
  return 'ok';
}

/** Renames a tab of the LED-screen version (recognised by one of its old columns) if it holds data. */
function keepLegacyTab(ss, name, marker) {
  var sheet = ss.getSheetByName(name);
  if (!sheet || sheet.getLastRow() < 2) return;
  var header = sheet.getRange(1, 1, 1, Math.max(1, sheet.getLastColumn())).getValues()[0].map(str);
  if (header.indexOf(marker) < 0) return;
  var target = name + ' (LED lama)', n = 2;
  while (ss.getSheetByName(target)) target = name + ' (LED lama ' + n++ + ')';
  sheet.setName(target);
  Logger.log('Tab "' + name + '" berisi data versi lama, disimpan sebagai "' + target + '".');
}

// ---------- request handling (pure: no HTTP objects, so it can be tested in Node) ----------

var HANDLERS = {
  'bootstrap': hBootstrap,
  'lookup': hLookup,
  'history': hHistory,
  'commit': hCommit,
  'item.add': hItemAdd,
  'item.update': hItemUpdate,
  'item.deactivate': hItemDeactivate,
  'storage.nextId': hStorageNextId,
  'storage.save': hStorageSave,
  'storage.assign': hStorageAssign,
  'storage.unassign': hStorageUnassign,
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
  snap.lists = readLists(ss);
  snap.conditions = CONDITIONS;
  snap.statuses = STATUSES;
  snap.onDuty = ON_DUTY;
  snap.cart = publicCart(ss, loadCart(ss, user).state);
  return snap;
}

/** Resolves a scanned code to an item, a storage unit, or both (a box label can be both). */
function hLookup(ss, payload) {
  var code = str(payload.code);
  if (!code) throw new AppError('Kode kosong.');
  var items = activeRows(readTable(ss, TABS.items, ITEM_COLS).rows);
  var storages = activeRows(readTable(ss, TABS.storage, STORAGE_COLS).rows);
  var item = findItem(items, code);
  var storage = findStorage(storages, code);
  if (!item && !storage) throw new AppError('Kode tidak ditemukan pada inventaris aktif: ' + code);
  var members = storage ? items.filter(function (x) { return x.storage_id === storage.storage_id; }) : [];
  return { item: item ? publicItem(item) : null, storage: storage ? publicStorage(storage, items) : null,
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

/** Check-out, check-in or condition check of the IDs in a cart. Date and person in charge are filled here. */
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
  var f = { event_date: now.slice(0, 10), from: '', to: '', condition: '', status: '', note: str(payload.note) };
  var item;
  if (action === 'INSPEKSI') {
    f.condition = pick(CONDITIONS, payload.condition);
    if (!f.condition) throw new AppError('Pilih hasil pemeriksaan: ' + CONDITIONS.join(', ') + '.');
    f.status = pick(STATUSES, payload.status);
    if (!f.status) throw new AppError('Pilih status: Active atau Passive.');
    if (NEEDS_NOTE[f.condition] && !f.note) throw new AppError('Catatan wajib diisi untuk kondisi ' + f.condition + ': apa yang perlu diperbaiki?');
  } else if (action === 'KELUAR') {
    f.to = str(payload.location);
    if (!f.to) throw new AppError('Lokasi tujuan / acara wajib diisi.');
    var onDuty = ids.filter(function (id) { return byId[id.toLowerCase()].location === ON_DUTY; });
    var passive = ids.filter(function (id) { return byId[id.toLowerCase()].status === 'Passive' && onDuty.indexOf(id) < 0; });
    var broken = ids.filter(function (id) {
      return byId[id.toLowerCase()].condition === 'Broken' && onDuty.indexOf(id) < 0 && passive.indexOf(id) < 0;
    });
    if (onDuty.length || passive.length || broken.length) {
      var why = [];
      if (onDuty.length) why.push(onDuty.length + ' barang sudah On Duty: ' + onDuty.join(', '));
      if (passive.length) why.push(passive.length + ' barang berstatus Passive dan tidak bisa dikeluarkan: ' + passive.join(', '));
      if (broken.length) why.push(broken.length + ' barang Broken dan tidak bisa dikeluarkan sampai diperbaiki: ' + broken.join(', '));
      throw new AppError(why.join('. ') + '.', onDuty.concat(passive, broken));
    }
  } else {
    var places = readLists(ss).places;
    f.to = pick(places, payload.storeLocation);
    if (!f.to) throw new AppError('Pilih tempat simpan: ' + places.join(', ') + '.');
    var notOut = ids.filter(function (id) { return byId[id.toLowerCase()].location !== ON_DUTY; });
    if (notOut.length) throw new AppError(notOut.length + ' barang tidak sedang On Duty, tidak bisa diproses masuk: ' + notOut.join(', '), notOut);
  }

  var txns = [];
  ids.forEach(function (id) {
    item = byId[id.toLowerCase()];
    var t = { event_date: f.event_date, from: '', to: f.to, condition: f.condition, status: f.status, note: f.note };
    if (action === 'KELUAR') { t.from = item.location; item.location = ON_DUTY; item.destination = f.to; }
    if (action === 'MASUK') { t.from = item.destination || ON_DUTY; item.location = f.to; item.destination = ''; }
    if (action === 'INSPEKSI') {
      item.condition = f.condition;
      item.status = f.status;
      item.condition_note = NEEDS_NOTE[f.condition] ? f.note : '';
      item.last_checked_at = now;
    }
    item.updated_at = now;
    item.last_user = user.name;
    txns.push(txnRow(now, batchId, action, item, t, user));
  });
  writeTable(table, ITEM_COLS);
  appendRows(ss, TABS.transactions, TXN_COLS, txns);

  var cartState = dropFromCart(ss, user, flowKey, ids);
  var verb = { INSPEKSI: 'Pengecekan', KELUAR: 'Barang keluar', MASUK: 'Barang masuk' }[action];
  var snap = withMessage(snapshot(ss), verb + ' tersimpan untuk ' + ids.length + ' unit.' + skippedNote);
  if (cartState) snap.cart = publicCart(ss, cartState);
  return snap;
}

/**
 * Adds equipment. Without ids the code is made here: category code - sub-category code - brand code -
 * last 4 characters of the serial number, or a 3-digit running number when there is no serial (one per unit
 * of quantity). With ids (labels already printed) those IDs are used as they are.
 */
function hItemAdd(ss, payload, user, batchId) {
  var v = itemFields(readLists(ss), payload);
  var table = readTable(ss, TABS.items, ITEM_COLS);
  var byId = indexItems(table.rows);
  var given = splitIds(payload.ids), ids = [], skipped = [];
  if (given.length) {
    if (given.length > MAX_IDS) throw new AppError('Maksimal ' + MAX_IDS + ' ID per proses.');
    var seen = {};
    given.forEach(function (id) {
      if (byId[id.toLowerCase()] || seen[id.toLowerCase()]) { skipped.push(id); return; }
      if (!/^[A-Za-z0-9._\-\/]{1,60}$/.test(id)) throw new AppError('ID hanya boleh huruf, angka, titik, strip dan garis miring: ' + id);
      seen[id.toLowerCase()] = true;
      ids.push(id);
    });
  } else {
    var quantity = v.serial ? 1 : Math.floor(Number(payload.quantity || 1));
    if (!(quantity >= 1 && quantity <= MAX_QUANTITY)) throw new AppError('Jumlah 1 sampai ' + MAX_QUANTITY + '.');
    ids = makeItemIds(table.rows, v.prefix, v.serial, quantity);
  }

  var now = nowStr(), txns = [];
  ids.forEach(function (id) {
    var item = newItem(v, id, now, user);
    byId[id.toLowerCase()] = item;
    table.rows.push(item);
    txns.push(txnRow(now, batchId, 'IMPORT', item, { to: item.location, condition: item.condition, status: item.status, note: 'Didaftarkan' }, user));
  });
  if (ids.length) {
    writeTable(table, ITEM_COLS);
    appendRows(ss, TABS.transactions, TXN_COLS, txns);
  }
  var snap = withMessage(snapshot(ss), ids.length + ' aset ditambahkan' + (skipped.length ? ', ' + skipped.length + ' duplikat dilewati.' : '.'));
  snap.addedIds = ids;
  snap.addedCount = ids.length;
  snap.skippedCount = skipped.length;
  snap.skipped = skipped.slice(0, 100);
  return snap;
}

/** The checks of Tambah Aset, shared with the Impor tab. Returns the cleaned fields and the code prefix, or throws. */
function itemFields(lists, f) {
  var category = pickValue(lists.categories, f.category);
  if (!category) throw new AppError('Pilih kategori.');
  var sub = pickValue(lists.subcategories.filter(function (s) { return !s.parent || s.parent === category.value; }), f.subcategory);
  if (!sub) throw new AppError('Pilih sub-kategori dari kategori ' + category.value + '.');
  var brand = str(f.brand), model = str(f.model);
  if (!brand) throw new AppError('Merk wajib diisi.');
  if (!model) throw new AppError('Type wajib diisi.');
  var location = f.location ? pick(lists.places.concat([ON_DUTY]), f.location) : lists.places[0];
  if (!location) throw new AppError('Pilih lokasi: ' + lists.places.concat([ON_DUTY]).join(', ') + '.');
  var condition = f.condition ? pick(CONDITIONS, f.condition) : 'Untested';
  if (!condition) throw new AppError('Kondisi tidak dikenal.');
  var status = f.status ? pick(STATUSES, f.status) : 'Active';
  if (!status) throw new AppError('Status harus Active atau Passive.');
  return { category: category.value, subcategory: sub.value, brand: brand, model: model, serial: str(f.serial),
    location: location, condition: condition, conditionNote: str(f.condition_note), status: status, note: str(f.note),
    prefix: [category.code || shortCode(category.value, 2), sub.code || shortCode(sub.value, 3), shortCode(brand, 3)].join('-') };
}

function newItem(v, id, now, user) {
  return { id: id, qr_value: id, category: v.category, subcategory: v.subcategory, brand: v.brand, model: v.model,
    serial: v.serial, location: v.location, destination: '', status: v.status, condition: v.condition,
    condition_note: v.conditionNote, note: v.note, storage_id: '', active: 'TRUE', created_at: now, updated_at: now,
    last_checked_at: '', last_user: user.name };
}

// ---------- Impor tab: an old list added in bulk, from the sheet itself ----------

/** Adds the Inventaris menu to the sheet. Its items run as whoever clicks them, so no access code is needed. */
function onOpen() {
  SpreadsheetApp.getUi().createMenu('Inventaris')
    .addItem('Cek tab Impor', 'checkImport')
    .addItem('Impor ke Items', 'runImport')
    .addToUi();
}

/** Marks every waiting Impor row with the code it will get, or why it cannot go in yet. Adds nothing. */
function checkImport() { return importReport(importRows(SpreadsheetApp.getActiveSpreadsheet(), false)); }

/** Adds the Impor rows that pass the checks and have an empty cek; writes each one's code back. */
function runImport() {
  return importReport(withLock(function () { return importRows(SpreadsheetApp.getActiveSpreadsheet(), true); }));
}

function importReport(message) {
  Logger.log(message);
  try { SpreadsheetApp.getActiveSpreadsheet().toast(message, 'Impor', 15); } catch (e) { /* run from the editor */ }
  return message;
}

var IMPORT_COLOURS = { done: '#d9ead3', waiting: '#fff2cc', error: '#f4cccc', ready: '#ffffff' };

function importRows(ss, commit) {
  var lists = readLists(ss);
  var imp = readTable(ss, TABS.imports, IMPORT_COLS);
  var items = readTable(ss, TABS.items, ITEM_COLS);
  var serials = {};
  items.rows.forEach(function (r) { if (isTrue(r.active) && r.serial) serials[r.serial.toUpperCase()] = r.id; });
  var now = nowStr(), user = { name: 'Impor' }, batchId = commit ? Utilities.getUuid() : '', txns = [];
  var count = { added: 0, ready: 0, waiting: 0, error: 0, done: 0 };
  var marks = {};  // sheet row -> [kode, hasil, state]
  imp.rows.forEach(function (r) {
    if (r.kode) { count.done++; marks[r._row] = [r.kode, r.hasil, 'done']; return; }
    var v;
    try {
      v = itemFields(lists, r);
      if (NEEDS_NOTE[v.condition] && !v.conditionNote) throw new AppError('Kondisi ' + v.condition + ' perlu condition_note.');
      if (v.serial && serials[v.serial.toUpperCase()]) throw new AppError('SN ini sudah terdaftar sebagai ' + serials[v.serial.toUpperCase()] + '.');
    } catch (e) {
      count.error++;
      marks[r._row] = ['', 'Belum bisa: ' + e.message, 'error'];
      return;
    }
    if (r.cek) { count.waiting++; marks[r._row] = ['', 'Menunggu cek: kosongkan kolom cek kalau sudah benar.', 'waiting']; return; }
    // Codes are reserved in sheet order, so the preview matches what the import will write.
    var id = makeItemIds(items.rows, v.prefix, v.serial, 1)[0];
    var item = newItem(v, id, now, user);
    items.rows.push(item);
    if (v.serial) serials[v.serial.toUpperCase()] = id;
    if (!commit) { count.ready++; marks[r._row] = ['', 'Siap, kode nanti ' + id, 'ready']; return; }
    txns.push(txnRow(now, batchId, 'IMPORT', item, { to: item.location, condition: item.condition, status: item.status,
      note: 'Impor' + (r.baris_lama ? ' dari baris ' + r.baris_lama : '') }, user));
    count.added++;
    marks[r._row] = [id, 'Masuk ' + now, 'done'];
  });
  if (commit && count.added) {
    writeTable(items, ITEM_COLS);
    appendRows(ss, TABS.transactions, TXN_COLS, txns);
  }
  var last = imp.sheet.getLastRow();
  if (last >= 2) {
    var kodeCol = IMPORT_COLS.indexOf('kode') + 1;
    var out = imp.sheet.getRange(2, kodeCol, last - 1, 2).getValues();
    var colours = [];
    for (var row = 2; row <= last; row++) {
      var m = marks[row];
      if (m) out[row - 2] = [m[0], m[1]];
      var colour = m ? IMPORT_COLOURS[m[2]] : IMPORT_COLOURS.ready;
      colours.push(IMPORT_COLS.map(function () { return colour; }));
    }
    imp.sheet.getRange(2, kodeCol, last - 1, 2).setValues(out);
    imp.sheet.getRange(2, 1, last - 1, IMPORT_COLS.length).setBackgrounds(colours);
  }
  return commit
    ? count.added + ' aset masuk, ' + count.waiting + ' menunggu cek, ' + count.error + ' belum bisa.'
    : count.ready + ' siap, ' + count.waiting + ' menunggu cek, ' + count.error + ' belum bisa. Belum ada yang dimasukkan.';
}

function hItemUpdate(ss, payload, user, batchId) {
  var id = str(payload.id);
  var table = readTable(ss, TABS.items, ITEM_COLS);
  var item = indexItems(table.rows)[id.toLowerCase()];
  if (!item || !isTrue(item.active)) throw new AppError('Barang tidak ditemukan: ' + id);
  var lists = readLists(ss);
  var next = {};
  if (payload.category !== undefined) {
    var c = pickValue(lists.categories, payload.category);
    if (!c) throw new AppError('Pilih kategori.');
    next.category = c.value;
  }
  if (payload.subcategory !== undefined) {
    var cat = next.category || item.category;
    var s = pickValue(lists.subcategories.filter(function (x) { return !x.parent || x.parent === cat; }), payload.subcategory);
    if (!s) throw new AppError('Pilih sub-kategori dari kategori ' + cat + '.');
    next.subcategory = s.value;
  }
  ['brand', 'model', 'serial', 'note'].forEach(function (k) { if (payload[k] !== undefined) next[k] = str(payload[k]); });
  if (next.brand === '') throw new AppError('Merk wajib diisi.');
  if (next.model === '') throw new AppError('Type wajib diisi.');
  if (payload.status !== undefined) {
    next.status = pick(STATUSES, payload.status);
    if (!next.status) throw new AppError('Status harus Active atau Passive.');
  }
  if (payload.location !== undefined && item.location !== ON_DUTY) {
    next.location = pick(lists.places, payload.location);
    if (!next.location) throw new AppError('Pilih lokasi: ' + lists.places.join(', ') + '.');
  }
  var changes = [];
  Object.keys(next).forEach(function (k) {
    if (next[k] !== item[k]) { changes.push(k + ': ' + (item[k] || '-') + ' -> ' + (next[k] || '-')); item[k] = next[k]; }
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
    item.storage_id = '';
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

// ---------- storage: pouches, bags, cases, containers ----------

function hStorageNextId(ss, payload) {
  var type = pickValue(readLists(ss).storageTypes, payload.storageType);
  if (!type) throw new AppError('Pilih jenis wadah.');
  return { storageId: nextStorageId(readTable(ss, TABS.storage, STORAGE_COLS).rows, type) };
}

/** Creates a storage unit (auto ID, or a custom ID such as the label on a case) or edits an existing one. */
function hStorageSave(ss, payload, user, batchId) {
  var table = readTable(ss, TABS.storage, STORAGE_COLS);
  var name = str(payload.name);
  if (!name) throw new AppError('Nama wadah wajib diisi.');
  var now = nowStr();
  var requestedId = str(payload.storageId);
  var existing = requestedId ? findStorage(table.rows, requestedId) : null;
  var storageId;
  if (existing && !payload.createNew) {
    existing.name = name;
    existing.category = str(payload.category);
    existing.note = str(payload.note);
    if (payload.storageType) {
      var t = pickValue(readLists(ss).storageTypes, payload.storageType);
      if (t) existing.storage_type = t.value;
    }
    existing.active = 'TRUE';
    existing.updated_at = now;
    storageId = existing.storage_id;
  } else {
    if (existing) throw new AppError('ID sudah dipakai: ' + requestedId);
    var type = pickValue(readLists(ss).storageTypes, payload.storageType);
    if (!type) throw new AppError('Pilih jenis wadah.');
    storageId = requestedId || nextStorageId(table.rows, type);
    if (!/^[A-Za-z0-9._\-\/]{1,50}$/.test(storageId)) throw new AppError('ID wadah hanya boleh huruf, angka, titik, strip dan garis miring (maks. 50).');
    table.rows.push({ storage_id: storageId, storage_type: type.value, name: name, category: str(payload.category),
      note: str(payload.note), active: 'TRUE', created_at: now, updated_at: now });
  }
  writeTable(table, STORAGE_COLS);
  var snap = withMessage(snapshot(ss), (existing && !payload.createNew ? 'Wadah diperbarui: ' : 'Wadah dibuat: ') + storageId);
  snap.storageId = storageId;
  return snap;
}

function hStorageAssign(ss, payload, user, batchId) {
  var storageId = str(payload.storageId);
  var ids = cleanIds(payload.ids);
  if (!storageId) throw new AppError('Pilih wadah tujuan.');
  if (!ids.length) throw new AppError('Pilih atau scan minimal satu aset.');
  var storage = findStorage(activeRows(readTable(ss, TABS.storage, STORAGE_COLS).rows), storageId);
  if (!storage) throw new AppError('Wadah tidak ditemukan: ' + storageId);
  var table = readTable(ss, TABS.items, ITEM_COLS);
  var byId = indexItems(table.rows);
  var missing = ids.filter(function (id) { return !byId[id.toLowerCase()] || !isTrue(byId[id.toLowerCase()].active); });
  if (missing.length) throw new AppError('ID tidak ditemukan pada inventaris aktif: ' + missing.join(', '), missing);
  var now = nowStr(), txns = [], moved = 0;
  ids.forEach(function (id) {
    var item = byId[id.toLowerCase()];
    if (item.storage_id === storage.storage_id) return;
    var from = item.storage_id;
    item.storage_id = storage.storage_id;
    item.updated_at = now;
    item.last_user = user.name;
    txns.push(txnRow(now, batchId, 'KELOMPOK', item, { from: from, to: storage.storage_id, note: from ? 'Dipindah dari ' + from : 'Masuk wadah' }, user));
    moved++;
  });
  if (moved) {
    writeTable(table, ITEM_COLS);
    appendRows(ss, TABS.transactions, TXN_COLS, txns);
  }
  var cartState = dropFromCart(ss, user, 'group', ids);
  var snap = withMessage(snapshot(ss), moved + ' aset masuk ke ' + storage.storage_id + '.');
  if (cartState) snap.cart = publicCart(ss, cartState);
  return snap;
}

function hStorageUnassign(ss, payload, user, batchId) {
  var ids = cleanIds(payload.ids);
  if (!ids.length) throw new AppError('Pilih aset yang dilepas.');
  var table = readTable(ss, TABS.items, ITEM_COLS);
  var byId = indexItems(table.rows);
  var now = nowStr(), txns = [], count = 0;
  ids.forEach(function (id) {
    var item = byId[id.toLowerCase()];
    if (!item || !isTrue(item.active) || !item.storage_id) return;
    var from = item.storage_id;
    item.storage_id = '';
    item.updated_at = now;
    item.last_user = user.name;
    var row = txnRow(now, batchId, 'LEPAS', item, { from: from, note: 'Dilepas dari ' + from }, user);
    row[TXN_COLS.indexOf('storage_id')] = from;
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
  // The revision is a timestamp, so it only ever grows, even if someone clears the Carts tab by hand:
  // open devices drop answers older than the one they show.
  c.state.rev = Math.max(c.state.rev + 1, Date.now());
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
  return [TABS.items, TABS.storage, TABS.transactions].map(function (n) {
    var sh = ss.getSheetByName(n);
    return sh ? sh.getLastRow() : 0;
  }).join('.');
}

// ---------- snapshot, lists and codes ----------

function snapshot(ss) {
  var items = activeRows(readTable(ss, TABS.items, ITEM_COLS).rows);
  var storages = activeRows(readTable(ss, TABS.storage, STORAGE_COLS).rows);
  var txns = readTable(ss, TABS.transactions, TXN_COLS).rows;
  var recent = txns.slice(Math.max(0, txns.length - RECENT_TXN)).reverse();
  var stats = { total: items.length, good: 0, needMaintenance: 0, broken: 0, untested: 0, onDuty: 0, inStorage: 0,
    passive: 0, storages: storages.length };
  items.forEach(function (x) {
    if (x.condition === 'Good') stats.good++;
    else if (x.condition === 'Need Maintenance') stats.needMaintenance++;
    else if (x.condition === 'Broken') stats.broken++;
    else stats.untested++;
    if (x.location === ON_DUTY) stats.onDuty++; else stats.inStorage++;
    if (x.status === 'Passive') stats.passive++;
  });
  return {
    items: items.map(publicItem),
    storages: storages.map(function (c) { return publicStorage(c, items); }),
    stats: stats,
    transactions: recent,
    dataRev: dataRev(ss),
    generatedAt: nowStr()
  };
}

function publicItem(x) {
  return { id: x.id, qrValue: x.qr_value, category: x.category, subcategory: x.subcategory, brand: x.brand,
    model: x.model, serial: x.serial, name: (x.brand + ' ' + x.model).trim(), location: x.location,
    destination: x.destination, out: x.location === ON_DUTY, status: x.status || 'Active',
    condition: x.condition || 'Untested', conditionNote: x.condition_note, note: x.note, storageId: x.storage_id,
    updatedAt: x.updated_at, lastCheckedAt: x.last_checked_at, lastUser: x.last_user };
}

function publicStorage(c, items) {
  var itemCount = 0, brokenCount = 0, outCount = 0;
  items.forEach(function (x) {
    if (x.storage_id !== c.storage_id) return;
    itemCount++;
    if (x.condition === 'Broken' || x.condition === 'Need Maintenance') brokenCount++;
    if (x.location === ON_DUTY) outCount++;
  });
  return { storageId: c.storage_id, storageType: c.storage_type, name: c.name, category: c.category, note: c.note,
    itemCount: itemCount, brokenCount: brokenCount, outCount: outCount };
}

function withMessage(snap, message) { snap.message = message; return snap; }

/** The Lists tab as the app needs it. A sheet without the tab yet gets the defaults. */
function readLists(ss) {
  var rows = ss.getSheetByName(TABS.lists) ? readTable(ss, TABS.lists, LIST_COLS).rows : DEFAULT_LISTS.map(function (r) {
    return { list: r[0], value: r[1], code: r[2], parent: r[3] };
  });
  var out = { categories: [], subcategories: [], places: [], storageTypes: [] };
  rows.forEach(function (r) {
    var list = str(r.list).toLowerCase(), value = str(r.value), code = str(r.code).toUpperCase();
    if (!value) return;
    if (list === 'kategori') out.categories.push({ value: value, code: code });
    else if (list === 'subkategori') out.subcategories.push({ value: value, code: code, parent: str(r.parent) });
    else if (list === 'lokasi' && value !== ON_DUTY) out.places.push(value);
    else if (list === 'wadah') out.storageTypes.push({ value: value, code: code });
  });
  if (!out.places.length) out.places = ['Storage'];
  return out;
}

/** Letters and digits of a name, upper case, cut or padded with X to n characters: "Sony" -> "SON". */
function shortCode(text, n) {
  var s = str(text).toUpperCase().replace(/[^A-Z0-9]/g, '');
  while (s.length < n) s += 'X';
  return s.slice(0, n);
}

/**
 * prefix-SN4 for a serial (a -2, -3 ... suffix if that code exists), else prefix-001, -002 ... after the highest
 * three-digit number. Only three digits count: an SN ending such as -0218 is four characters and is not a running
 * number. Past 999 the numbers grow to four digits and simply skip any code already taken.
 */
function makeItemIds(rows, prefix, serial, quantity) {
  var taken = {};
  rows.forEach(function (r) { if (r.id) taken[r.id.toUpperCase()] = true; });
  if (serial) {
    var tail = str(serial).toUpperCase().replace(/[^A-Z0-9]/g, '');
    tail = tail.slice(-4) || '0000';
    var base = prefix + '-' + tail, id = base, n = 2;
    while (taken[id]) id = base + '-' + n++;
    return [id];
  }
  var max = 0, re = new RegExp('^' + prefix.replace(/[-]/g, '\\-') + '-(\\d{3})$');
  Object.keys(taken).forEach(function (id) { var m = re.exec(id); if (m) max = Math.max(max, Number(m[1])); });
  var ids = [];
  while (ids.length < quantity) {
    var num = String(++max);
    while (num.length < 3) num = '0' + num;
    if (!taken[prefix + '-' + num]) ids.push(prefix + '-' + num);
  }
  return ids;
}

function nextStorageId(rows, type) {
  var prefix = (type.code || shortCode(type.value, 3)) + '-';
  var max = 0;
  rows.forEach(function (r) {
    if (r.storage_id.toUpperCase().indexOf(prefix) !== 0) return;
    var m = /^(\d+)$/.exec(r.storage_id.slice(prefix.length));
    if (m) max = Math.max(max, Number(m[1]));
  });
  var n = String(max + 1);
  while (n.length < 3) n = '0' + n;
  return prefix + n;
}

/** Case-insensitive match against a list of strings; returns the list's own spelling. */
function pick(list, v) {
  var k = str(v).toLowerCase();
  if (!k) return '';
  for (var i = 0; i < list.length; i++) if (list[i].toLowerCase() === k) return list[i];
  return '';
}
function pickValue(list, v) {
  var k = str(v).toLowerCase();
  if (!k) return null;
  for (var i = 0; i < list.length; i++) if (list[i].value.toLowerCase() === k) return list[i];
  return null;
}

// ---------- sheet access ----------

function ensureTab(ss, name, cols) {
  var sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  var header = sheet.getRange(1, 1, 1, cols.length);
  var current = header.getValues()[0].map(str);
  var same = current.length === cols.length && current.every(function (v, i) { return v === cols[i]; });
  if (!same) {
    // A tab with only a header (or nothing) takes the new columns; one with data rows is never rewritten.
    if (sheet.getLastRow() > 1) {
      throw new Error('Tab "' + name + '" sudah berisi data dengan kolom lain. Ganti nama tab lama dulu, lalu jalankan setup() lagi.');
    }
    if (current.length > cols.length || sheet.getLastColumn() > cols.length) sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), cols.length)).clearContent();
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
  return [ts, batchId || '', action, item.id, (item.brand + ' ' + item.model).trim(), item.category, str(f.event_date),
    str(f.from), str(f.to), item.storage_id || '', str(f.condition), str(f.status), str(f.note), user.name];
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

function findStorage(storages, code) {
  var k = code.toLowerCase();
  for (var i = 0; i < storages.length; i++) if (storages[i].storage_id.toLowerCase() === k) return storages[i];
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

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
