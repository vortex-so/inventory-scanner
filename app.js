/* Vortex Inventory front end. Plain JS, no build step.
   Talks to apps-script/Code.gs with JSON POSTs. See README.md. */
(function () {
  'use strict';

  var cfg = window.APP_CONFIG || {};
  var SESSION_KEY = 'inventory-scanner.session';
  var CAMERA_KEY = 'inventory-scanner.camera';
  var CART_KEY = 'inventory-scanner.cart';
  var LABEL_KEY = 'inventory-scanner.labels';
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };

  var ICON = {
    check: '<svg class="i" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="m8.5 12 2.5 2.5 4.5-5"/></svg>',
    out: '<svg class="i" viewBox="0 0 24 24"><path d="M7 17 17 7"/><path d="M9 7h8v8"/></svg>',
    inn: '<svg class="i" viewBox="0 0 24 24"><path d="M17 7 7 17"/><path d="M15 17H7V9"/></svg>',
    clock: '<svg class="i" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
    edit: '<svg class="i" viewBox="0 0 24 24"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
    trash: '<svg class="i" viewBox="0 0 24 24"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="m19 6-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/></svg>',
    box: '<svg class="i" viewBox="0 0 24 24"><path d="m12 3 8 4.5v9L12 21l-8-4.5v-9z"/><path d="M4 7.5 12 12l8-4.5"/><path d="M12 12v9"/></svg>',
    chev: '<svg class="i chev" viewBox="0 0 24 24"><path d="m9 6 6 6-6 6"/></svg>',
    scan: '<svg class="i" viewBox="0 0 24 24"><path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3"/><path d="M4 12h16"/></svg>'
  };

  var FLOWS = {
    check: { action: 'INSPEKSI', title: 'Keranjang Pengecekan Kondisi', unit: 'unit' },
    out: { action: 'KELUAR', title: 'Keranjang Barang Keluar', unit: 'unit' },
    in: { action: 'MASUK', title: 'Keranjang Barang Masuk/Kembali', unit: 'unit' },
    group: { action: null, title: 'Keranjang Pengelompokan', unit: 'aset' }
  };
  var FLOW_NAMES = { check: 'Pengecekan Kondisi', out: 'Barang Keluar', in: 'Barang Masuk/Kembali', group: 'Kelompokkan ke Kabinet/Box' };
  var PAGE_TITLES = { home: 'Dashboard', scan: 'Scan & Keranjang', inventory: 'Data Inventory', containers: 'Manajemen Kabinet & Box', history: 'Riwayat', labels: 'Cetak QR Code' };
  var ACTION_LABEL = { KELUAR: 'Keluar', MASUK: 'Masuk', INSPEKSI: 'Pengecekan', KELOMPOK: 'Kelompok', LEPAS: 'Lepas', IMPORT: 'Didaftarkan', EDIT: 'Edit', NONAKTIF: 'Nonaktif' };
  var TYPE_LABELS = {
    'MODUL': 'Modul LED', 'BOX': 'Box / Case', 'POWER SUPPLY': 'Power Supply', 'MOBO': 'MOBO', 'BRACKET': 'Bracket',
    'POWER PANEL LISTRIK 3 PHASE': 'Power Panel Listrik 3 Phase', 'PROSESSOR': 'Prosessor', 'LIGHTING': 'Lighting',
    'LIGHTING STAND': 'Lighting Stand', 'KABEL JUMPER MALE 120CM': 'Kabel Jumper Male 120CM', 'KABEL JUMPER BESAR': 'Kabel Jumper Besar',
    'KABEL LAN 120CM': 'Kabel LAN 120CM', 'KLEM BUTTERFLY HITAM': 'Klem Butterfly Hitam', 'BAUT HEXAGONE': 'Baut Hexagone',
    'MODUL BACKUP': 'Modul Backup', 'POWER SUPPLY BACKUP': 'Power Supply Backup', 'MOBO BACKUP': 'Mobo Backup', 'REGGING': 'Regging',
    'TOOLS': 'Tools', 'KABEL XLR': 'Kabel XLR', 'MIXER LAMPU': 'Mixer Lampu', 'KABEL LAN PANJANG': 'Kabel LAN Panjang',
    'TRIPOD': 'Tripod', 'LIGHT STAND ACCESORIS': 'Light Stand Accesoris'
  };
  var typeLabel = function (t) { return TYPE_LABELS[t] || t || '-'; };

  var state = { me: null, items: [], containers: [], stats: {}, transactions: [], types: Object.keys(TYPE_LABELS) };
  var session = null;
  // One backend per unit (a sheet plus its script). config.js lists them; a single apiUrl is one unit.
  var units = Array.isArray(cfg.units) && cfg.units.length ? cfg.units.filter(function (u) { return u && u.apiUrl; })
    : (cfg.apiUrl ? [{ key: 'default', name: cfg.appName || 'Inventory', apiUrl: cfg.apiUrl }] : []);
  function currentUnit() {
    var k = session && session.unit;
    return units.filter(function (u) { return u.key === k; })[0] || units[0];
  }
  var carts = { check: [], out: [], in: [], group: [] };
  var drafts = {};
  var pendingBatch = {};
  var flow = 'check';
  var groupTarget = '';
  var page = 'home';
  var inventoryFilter = '';
  var scanner = null, cameraOn = false, lastCode = '', lastAt = 0, lookupScanner = null;
  var labelSelected = {};
  var lastRefresh = 0;
  var audio = null;
  var cartsReady = false; // persistCarts() stays quiet until the saved cart has been restored, or the first render would wipe it
  // Shared cart: every device logged in with the same name and code sees one cart. Changes go up as small
  // operations (ops) and the other devices pick them up by polling; see the "shared cart" section below.
  var sync = { on: false, ops: [], rev: -1, busy: null, timer: 0, polling: false, lastPoll: 0, dataRev: '', refetching: false };

  // ---------- small UI helpers ----------

  var toastTimer;
  function toast(msg, error) {
    var el = $('toast');
    el.textContent = msg;
    el.className = 'toast show' + (error ? ' error' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.className = 'toast'; }, error ? 6000 : 3500);
  }
  function loading(show, text) {
    $('loadingText').textContent = text || 'Memuat...';
    $('loading').className = show ? 'show' : '';
  }
  function buzz(ok) {
    if (navigator.vibrate) { try { navigator.vibrate(ok ? 60 : [60, 60, 60]); } catch (e) { /* ignore */ } }
    beep(ok);
  }
  // A short tone besides the vibration: warehouses are loud and the phone is not always in a hand.
  function ensureAudio() {
    if (audio) return;
    try { var Ctx = window.AudioContext || window.webkitAudioContext; if (Ctx) audio = new Ctx(); } catch (e) { audio = null; }
  }
  function beep(ok) {
    if (!audio) return;
    try {
      if (audio.state === 'suspended') audio.resume();
      var t = audio.currentTime;
      var tones = ok ? [[1046, 0, .07]] : [[330, 0, .09], [330, .12, .09]];
      tones.forEach(function (tone) {
        var o = audio.createOscillator(), g = audio.createGain();
        o.type = 'sine'; o.frequency.value = tone[0];
        g.gain.setValueAtTime(0.0001, t + tone[1]);
        g.gain.exponentialRampToValueAtTime(0.25, t + tone[1] + 0.01);
        g.gain.exponentialRampToValueAtTime(0.0001, t + tone[1] + tone[2]);
        o.connect(g); g.connect(audio.destination);
        o.start(t + tone[1]); o.stop(t + tone[1] + tone[2] + 0.02);
      });
    } catch (e) { /* no sound, fine */ }
  }
  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'b-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }
  function today() { return new Date().toLocaleDateString('en-CA'); }
  function hhmm(s) { var m = /(\d\d):(\d\d)/.exec(String(s || '')); return m ? m[1] + ':' + m[2] : ''; }
  function shortDate(s) { return String(s || '').slice(0, 10); }
  function show(viewId) {
    ['setupView', 'loginView', 'appView'].forEach(function (id) { $(id).classList.toggle('hidden', id !== viewId); });
    document.body.classList.toggle('has-nav', viewId === 'appView');
  }

  // Renders a list in chunks as the user scrolls. The data is already in memory; only the DOM is lazy.
  function lazyList(host, items, renderOne, opts) {
    opts = opts || {};
    var chunk = opts.chunk || 60, isRow = opts.row === 'tr', i = 0;
    if (host._lazy) { host._lazy.disconnect(); host._lazy = null; }
    host.innerHTML = '';
    if (!items.length) { host.innerHTML = opts.empty || '<div class="empty">Tidak ada data.</div>'; return; }
    var sentinel = document.createElement(isRow ? 'tr' : 'div');
    sentinel.className = 'sentinel';
    if (isRow) sentinel.innerHTML = '<td colspan="99"></td>';
    host.appendChild(sentinel);
    var tmp = document.createElement(isRow ? 'tbody' : 'div');
    function more() {
      var end = Math.min(items.length, i + chunk), html = '';
      for (; i < end; i++) html += renderOne(items[i]);
      tmp.innerHTML = html;
      var frag = document.createDocumentFragment();
      while (tmp.firstElementChild) frag.appendChild(tmp.firstElementChild);
      host.insertBefore(frag, sentinel);
      if (i >= items.length) { sentinel.remove(); if (host._lazy) { host._lazy.disconnect(); host._lazy = null; } }
    }
    more();
    if (i < items.length) {
      if ('IntersectionObserver' in window) {
        host._lazy = new IntersectionObserver(function (entries) {
          if (entries.some(function (e) { return e.isIntersecting; })) more();
        }, { rootMargin: '600px 0px' });
        host._lazy.observe(sentinel);
      } else { while (i < items.length) more(); }
    }
  }

  function openDialog(html, onClose) {
    var d = $('dlg');
    d.innerHTML = '<div class="box">' + html + '</div>';
    d._onClose = onClose || null;
    if (typeof d.showModal === 'function') d.showModal(); else d.setAttribute('open', '');
    return d;
  }
  function closeDialog() {
    var d = $('dlg');
    var fn = d._onClose; d._onClose = null;
    if (d.open) d.close();
    d.innerHTML = '';
    if (fn) fn();
  }
  function confirmDialog(title, text, okLabel, danger) {
    return new Promise(function (resolve) {
      var d = openDialog('<h2>' + esc(title) + '</h2><p>' + esc(text) + '</p>' +
        '<div class="actions"><button class="btn secondary" data-r="0" type="button">Batal</button>' +
        '<button class="btn ' + (danger ? 'danger' : 'success') + '" data-r="1" type="button">' + esc(okLabel || 'Ya') + '</button></div>');
      d.querySelectorAll('button').forEach(function (b) { b.addEventListener('click', function () { closeDialog(); resolve(b.dataset.r === '1'); }); });
      d.addEventListener('cancel', function () { resolve(false); }, { once: true });
    });
  }
  function formDialog(title, fieldsHtml, okLabel) {
    return new Promise(function (resolve) {
      var d = openDialog('<form method="dialog"><h2>' + esc(title) + '</h2>' + fieldsHtml +
        '<div class="actions"><button class="btn secondary" type="button" data-r="0">Batal</button><button class="btn" type="submit">' + esc(okLabel || 'Simpan') + '</button></div></form>');
      var form = d.querySelector('form');
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        var out = {};
        new FormData(form).forEach(function (v, k) { out[k] = String(v).trim(); });
        closeDialog(); resolve(out);
      });
      d.querySelector('[data-r="0"]').addEventListener('click', function () { closeDialog(); resolve(null); });
      d.addEventListener('cancel', function () { resolve(null); }, { once: true });
      var first = form.querySelector('input,select,textarea'); if (first) first.focus();
    });
  }

  // ---------- API ----------

  function api(action, payload, opts) {
    opts = opts || {};
    if (!opts.silent) loading(true, opts.loadingText || 'Menghubungi server...');
    var body = JSON.stringify({ user: session.user, code: session.code, action: action, payload: payload || {}, batchId: opts.batchId || '' });
    return fetch(currentUnit().apiUrl, { method: 'POST', body: body, redirect: 'follow' })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (data) {
        if (!data || !data.ok) {
          var e = new Error((data && data.error) || 'Permintaan gagal.');
          e.app = true; e.invalid = (data && data.invalid) || [];
          throw e;
        }
        return data.data;
      })
      .catch(function (err) {
        if (err.app) throw err;
        var e = new Error('Tidak bisa menghubungi server: ' + err.message + '. Periksa sinyal, lalu coba Simpan lagi.');
        e.network = true;
        throw e;
      })
      .finally(function () { if (!opts.silent) loading(false); });
  }

  function refreshQuiet(announce) {
    lastRefresh = Date.now();
    var b = $('refreshBtn');
    if (b) b.classList.add('spin');
    return api('bootstrap', {}, { silent: true })
      .then(function (d) { applySnapshot(d); if (announce) toast('Data diperbarui.'); })
      .catch(function (e) { if (announce) toast(e.message, true); })
      .then(function () { if (b) b.classList.remove('spin'); });
  }

  function applySnapshot(d) {
    if (!d) return;
    lastRefresh = Date.now();
    if (d.items) state.items = d.items;
    if (d.containers) state.containers = d.containers;
    if (d.stats) state.stats = d.stats;
    if (d.transactions) state.transactions = d.transactions;
    if (d.types && d.types.length) state.types = d.types;
    if (d.me) state.me = d.me;
    if (d.dataRev) sync.dataRev = d.dataRev;
    renderAll();
    if (state.me) updateTitles();
  }

  // ---------- login ----------

  function init() {
    if (!units.length) { show('setupView'); return; }
    $('loginTitle').textContent = cfg.appName || 'Vortex Inventory';
    document.title = cfg.appName || 'Vortex Inventory';
    var sel = $('loginUnit');
    sel.innerHTML = units.map(function (u) { return '<option value="' + esc(u.key) + '">' + esc(u.name) + '</option>'; }).join('');
    $('loginUnitWrap').classList.toggle('hidden', units.length < 2);
    try { session = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); } catch (e) { session = null; }
    if (session && session.unit) sel.value = session.unit;
    bindEvents();
    if (session && session.user && session.code) bootstrap();
    else show('loginView');
  }
  function unitLabel() { var u = currentUnit(); return units.length > 1 ? u.name : (cfg.appName || 'Vortex Inventory'); }

  function bootstrap() {
    return api('bootstrap', {}, { loadingText: 'Memuat inventaris...' }).then(function (d) {
      try { localStorage.setItem(SESSION_KEY, JSON.stringify(session)); } catch (e) { /* private mode */ }
      applySnapshot(d);
      $('whoName').textContent = state.me.name;
      $('whoRole').textContent = state.me.role === 'admin' ? 'admin' : 'operator';
      $('whoAvatar').textContent = state.me.name.split(/\s+/).map(function (w) { return w[0]; }).join('').slice(0, 2).toUpperCase();
      $('sideFoot').textContent = location.host;
      $('brandName').textContent = unitLabel();
      $('whoRole').textContent = (state.me.role === 'admin' ? 'admin' : 'operator') + (units.length > 1 ? ' · ' + currentUnit().name : '');
      document.body.classList.toggle('is-admin', state.me.role === 'admin');
      $('importBtn').classList.toggle('hidden', state.me.role !== 'admin');
      restoreCarts(d.cart);
      show('appView');
      showPage(page);
    }).catch(function (e) {
      if (e.app) { logout(); $('loginError').textContent = e.message; $('loginError').classList.remove('hidden'); }
      else { toast(e.message, true); show('loginView'); }
    });
  }

  function logout() {
    stopCamera();
    session = null;
    Object.keys(carts).forEach(function (f) { carts[f] = []; });
    drafts = {}; groupTarget = ''; cartsReady = false;
    clearTimeout(sync.timer); sync.on = false; sync.ops = []; sync.rev = -1;
    try { localStorage.removeItem(SESSION_KEY); } catch (e) { /* ignore */ }
    $('loginError').classList.add('hidden');
    $('loginCode').value = '';
    show('loginView');
  }

  // ---------- navigation ----------

  function showPage(name) {
    if (!$('page-' + name)) name = 'home';
    if (page === 'scan' && name !== 'scan') stopCamera(true);
    page = name;
    document.querySelectorAll('.page').forEach(function (p) { p.classList.toggle('active', p.id === 'page-' + name); });
    document.querySelectorAll('#nav button').forEach(function (b) { b.classList.toggle('active', b.dataset.page === name); });
    updateTitles();
    window.scrollTo(0, 0);
    if (name === 'scan' && cameraWanted() && !cameraOn) startCamera();
  }
  function updateTitles() {
    var t = lastRefresh ? new Date(lastRefresh) : null;
    var stamp = t ? 'Diperbarui ' + ('0' + t.getHours()).slice(-2) + ':' + ('0' + t.getMinutes()).slice(-2) : '';
    $('pageTitle').textContent = page === 'scan' ? FLOW_NAMES[flow] : (PAGE_TITLES[page] || page);
    $('pageSub').textContent = page === 'scan' ? 'Scan, isi keranjang, Simpan.' : stamp;
    document.querySelectorAll('#sidebar .navbtn').forEach(function (b) {
      b.classList.toggle('active', b.dataset.page === page && (!b.dataset.flow || b.dataset.flow === flow));
    });
  }

  function setFlow(name) {
    if (!FLOWS[name]) return;
    flow = name;
    document.querySelectorAll('#flowTabs button').forEach(function (b) { b.classList.toggle('active', b.dataset.flow === name); });
    $('groupTargetWrap').classList.toggle('hidden', name !== 'group');
    $('groupPick').classList.toggle('hidden', name !== 'group');
    $('groupUnassign').classList.toggle('hidden', name !== 'group');
    $('scanHeading').textContent = 'Scan QR — ' + FLOW_NAMES[name];
    updateTitles();
    renderCart();
    if (name === 'group') renderGroupPick();
  }

  function goScan(f) { setFlow(f); showPage('scan'); }

  // ---------- scanning ----------

  function scanStatus(text, kind) {
    var el = $('scanStatus');
    el.textContent = text;
    el.className = 'scanstatus' + (kind ? ' ' + kind : '');
  }
  function cameraWanted() { try { return localStorage.getItem(CAMERA_KEY) === '1'; } catch (e) { return false; } }
  function rememberCamera(on) { try { if (on) localStorage.setItem(CAMERA_KEY, '1'); else localStorage.removeItem(CAMERA_KEY); } catch (e) { /* ignore */ } }

  function makeScanner(elementId) {
    var formats = window.Html5QrcodeSupportedFormats ? [Html5QrcodeSupportedFormats.QR_CODE] : undefined;
    return new Html5Qrcode(elementId, { verbose: false, formatsToSupport: formats, experimentalFeatures: { useBarCodeDetectorIfSupported: true } });
  }
  var SCAN_CONFIG = { fps: 10, aspectRatio: 1, qrbox: function (w, h) { var s = Math.floor(Math.min(w, h) * 0.75); return { width: s, height: s }; } };

  function startCamera() {
    if (cameraOn) return;
    if (!window.Html5Qrcode) { scanStatus('Pustaka kamera tidak termuat. Muat ulang halaman.', 'err'); return; }
    ensureAudio();
    scanStatus('Membuka kamera...');
    try {
      if (!scanner) scanner = makeScanner('reader');
      scanner.start({ facingMode: 'environment' }, SCAN_CONFIG, onDecoded, function () { /* no code in frame */ }).then(function () {
        cameraOn = true;
        rememberCamera(true);
        $('viewfinder').classList.add('on');
        $('camStart').disabled = true;
        scanStatus('Kamera aktif. Arahkan ke QR.', '');
      }).catch(cameraFailed);
    } catch (err) { cameraFailed(err); }
  }
  function cameraFailed(err) {
    cameraOn = false;
    rememberCamera(false);
    var msg = (err && err.message) || String(err || '');
    scanStatus('Kamera tidak bisa dibuka: ' + msg + '. Izinkan kamera untuk situs ini, pastikan alamat https, dan buka di Chrome/Safari, bukan di browser WhatsApp.', 'err');
  }
  /** keep=true leaves the "auto-start next time" preference alone (leaving the page); false forgets it (user pressed Hentikan). */
  function stopCamera(keep) {
    $('camStart').disabled = false;
    $('viewfinder').classList.remove('on');
    if (!keep) rememberCamera(false);
    if (!scanner || !cameraOn) return;
    cameraOn = false;
    scanner.stop().then(function () { scanner.clear(); }).catch(function () { /* already stopped */ });
  }
  function onDecoded(text) {
    var now = Date.now();
    if (text === lastCode && now - lastAt < 2000) return;
    lastCode = text; lastAt = now;
    handleCode(text);
  }

  function findLocal(code) {
    var k = code.toLowerCase();
    var item = null, container = null;
    for (var i = 0; i < state.items.length; i++) {
      var x = state.items[i];
      if (x.id.toLowerCase() === k || (x.qrValue && x.qrValue.toLowerCase() === k)) { item = x; break; }
    }
    for (var j = 0; j < state.containers.length; j++) {
      if (state.containers[j].cabinetId.toLowerCase() === k) { container = state.containers[j]; break; }
    }
    var members = container ? state.items.filter(function (x) { return x.cabinetId === container.cabinetId; }) : [];
    return { item: item, container: container, members: members };
  }

  function resolveCode(code) {
    var hit = findLocal(code);
    if (hit.item || hit.container) return Promise.resolve(hit);
    return api('lookup', { code: code }, { silent: true }).then(function (d) {
      if (d.item && !state.items.some(function (x) { return x.id === d.item.id; })) state.items.push(d.item);
      if (d.container && !state.containers.some(function (c) { return c.cabinetId === d.container.cabinetId; })) state.containers.push(d.container);
      return { item: d.item, container: d.container, members: d.members || [] };
    });
  }

  function handleCode(raw) {
    var code = String(raw || '').trim();
    if (!code) return Promise.resolve(false);
    return resolveCode(code).then(function (hit) { return addHit(hit, code); }).catch(function (e) {
      scanStatus('Tidak ditemukan: ' + code, 'err');
      buzz(false);
      toast(e.message, true);
      return false;
    });
  }

  function addHit(hit, code) {
    if (flow === 'group') {
      if (hit.container) {
        if (carts.group.length && groupTarget && groupTarget !== hit.container.cabinetId) {
          scanStatus('Keranjang masih untuk ' + groupTarget + '. Kosongkan dulu untuk ganti tujuan.', 'err'); buzz(false); return false;
        }
        setGroupTarget(hit.container.cabinetId);
        scanStatus('Tujuan: ' + hit.container.cabinetId + ' (' + hit.container.name + '). Sekarang scan isinya.', 'ok');
        buzz(true); renderGroupPick(); persistCarts(); return true;
      }
      if (!groupTarget) { scanStatus('Pilih atau scan kabinet/box tujuan dulu.', 'err'); buzz(false); return false; }
      if (pushCart(hit.item, 'group', '')) { scanStatus('Masuk keranjang: ' + hit.item.id, 'ok'); buzz(true); return true; }
      scanStatus('Sudah ada di keranjang: ' + hit.item.id, 'err'); buzz(false); return false;
    }
    var added = 0, total = 0;
    if (hit.container) {
      hit.members.forEach(function (m) { total++; if (pushCart(m, flow, hit.container.cabinetId)) added++; });
      if (hit.item) { total++; if (pushCart(hit.item, flow, '')) added++; }
      if (!total) { scanStatus('Wadah ' + hit.container.cabinetId + ' belum punya isi.', 'err'); buzz(false); return false; }
      scanStatus(added + ' dari ' + total + ' aset wadah ' + hit.container.cabinetId + ' masuk keranjang.', added ? 'ok' : 'err');
      buzz(added > 0); return added > 0;
    }
    if (pushCart(hit.item, flow, '')) { scanStatus('Masuk keranjang: ' + hit.item.id, 'ok'); buzz(true); return true; }
    scanStatus('Sudah ada di keranjang: ' + hit.item.id, 'err'); buzz(false); return false;
  }

  /** Newest scan goes to the top of the cart so the operator sees it land. */
  function pushCart(item, f, cabinetId) {
    if (!item) return false;
    var cart = carts[f];
    for (var i = 0; i < cart.length; i++) {
      if (cart[i].id !== item.id) continue;
      if (cabinetId && cart[i]._cartCabinetId !== cabinetId) {
        cart[i]._cartCabinetId = cabinetId;
        queueOp({ op: 'add', flow: f, items: [{ id: item.id, cab: cabinetId }] });
      }
      return false;
    }
    cart.unshift(cartCopy(item, cabinetId, Date.now()));
    queueOp({ op: 'add', flow: f, items: [{ id: item.id, cab: cabinetId || '' }] });
    renderCart();
    return true;
  }
  function cartCopy(item, cab, at) {
    var copy = {};
    for (var k in item) copy[k] = item[k];
    copy._cartCabinetId = cab || '';
    copy._at = at || 0;
    return copy;
  }
  function removeFromCart(f, id) {
    carts[f] = carts[f].filter(function (x) { return x.id !== id; });
    queueOp({ op: 'remove', flow: f, ids: [id] });
    renderCart();
  }
  function clearCart(f) {
    carts[f] = [];
    queueOp({ op: 'clear', flow: f });
    if (f === 'group') setGroupTarget('');
    renderCart();
  }
  function setGroupTarget(id) {
    groupTarget = id || '';
    queueOp({ op: 'target', id: groupTarget });
    var sel = $('groupTarget');
    if (sel) sel.value = groupTarget;
    persistCarts();
  }

  // The cart is also kept in this device's storage: with the shared cart it holds the changes not yet sent
  // (no signal), and with an older backend it is the cart itself. Either way a closed browser loses nothing.
  function cartKey() { return CART_KEY + '.' + (currentUnit() ? currentUnit().key : 'x') + '.' + (session && session.user ? session.user.toLowerCase() : 'x'); }
  function persistCarts() {
    if (!session || !cartsReady) return;
    try {
      var slim = {};
      Object.keys(carts).forEach(function (f) { slim[f] = carts[f].map(function (x) { return { id: x.id, cab: x._cartCabinetId || '' }; }); });
      localStorage.setItem(cartKey(), JSON.stringify({ carts: slim, ops: sync.on ? sync.ops : [], drafts: drafts, flow: flow, groupTarget: groupTarget, at: Date.now() }));
    } catch (e) { /* storage unavailable: nothing to do */ }
  }
  function restoreCarts(serverCart) {
    var saved = null;
    try { saved = JSON.parse(localStorage.getItem(cartKey()) || 'null'); } catch (e) { saved = null; }
    saved = saved || {};
    var byId = {}; state.items.forEach(function (x) { byId[x.id] = x; });
    drafts = saved.drafts || {};
    if (saved.flow && FLOWS[saved.flow]) flow = saved.flow;
    Object.keys(carts).forEach(function (f) { carts[f] = []; });
    groupTarget = '';
    sync.on = !!(serverCart && typeof serverCart.rev === 'number');
    sync.rev = -1;
    sync.ops = [];
    if (sync.on) {
      sync.ops = (Array.isArray(saved.ops) ? saved.ops : []).filter(function (op) { return op && op.op; });
      if (serverCart.rev === 0 && !sync.ops.length && saved.carts) {
        // A cart kept on this device before carts were shared goes up once, oldest first so the order holds.
        Object.keys(carts).forEach(function (f) {
          (saved.carts[f] || []).slice().reverse().forEach(function (e) {
            if (byId[e.id]) sync.ops.push({ op: 'add', flow: f, items: [{ id: e.id, cab: e.cab || '' }] });
          });
        });
        if (saved.groupTarget) sync.ops.push({ op: 'target', id: saved.groupTarget });
      }
      cartsReady = true;
      applyCartState(serverCart);
      if (sync.ops.length) scheduleFlush(100);
    } else {
      Object.keys(carts).forEach(function (f) {
        carts[f] = ((saved.carts && saved.carts[f]) || []).map(function (e) { return byId[e.id] ? cartCopy(byId[e.id], e.cab, 0) : null; }).filter(Boolean);
      });
      if (saved.groupTarget && state.containers.some(function (c) { return c.cabinetId === saved.groupTarget; })) groupTarget = saved.groupTarget;
      cartsReady = true;
    }
    setFlow(flow);
    var restored = 0;
    Object.keys(carts).forEach(function (f) { restored += carts[f].length; });
    if (restored) { page = 'scan'; toast('Keranjang dipulihkan: ' + restored + ' unit dari sebelumnya.'); }
  }

  // ---------- shared cart ----------
  // Devices never send a whole cart, only "add these", "remove these", "clear", "target". The server applies
  // them in order, so scans from two phones in the same second are both kept. Each device shows its own
  // changes at once and applies the server's copy plus its unsent changes whenever the server answers.

  function queueOp(op) {
    if (!sync.on) return;
    sync.ops.push(op);
    persistCarts();
    scheduleFlush(250);
  }
  function scheduleFlush(ms) {
    clearTimeout(sync.timer);
    sync.timer = setTimeout(flushOps, ms);
  }
  /** Sends the queued changes. Always resolves; on no signal it tries again in 5 s and keeps the changes. */
  function flushOps() {
    if (!sync.on || !session) return Promise.resolve();
    if (sync.busy) return sync.busy;
    if (!sync.ops.length) return Promise.resolve();
    var sending = sync.ops.slice(0, 500);
    sync.busy = api('cart.apply', { ops: sending }, { silent: true }).then(function (st) {
      sync.ops = sync.ops.slice(sending.length);
      sync.busy = null;
      applyCartState(st, true);
      persistCarts();
      if (sync.ops.length) return flushOps();
    }, function (e) {
      sync.busy = null;
      if (e.app) { sync.ops = sync.ops.slice(sending.length); toast(e.message, true); return; }
      scheduleFlush(5000);
    });
    return sync.busy;
  }
  function applyOpLocal(op, byId, before) {
    if (op.op === 'target') { groupTarget = op.id || ''; return; }
    var f = op.flow;
    if (!carts[f]) return;
    if (op.op === 'clear') { carts[f] = []; return; }
    if (op.op === 'remove') {
      var gone = {}; (op.ids || []).forEach(function (id) { gone[id] = true; });
      carts[f] = carts[f].filter(function (x) { return !gone[x.id]; });
      return;
    }
    if (op.op === 'add') (op.items || []).forEach(function (e) {
      for (var i = 0; i < carts[f].length; i++) if (carts[f][i].id === e.id) { if (e.cab) carts[f][i]._cartCabinetId = e.cab; return; }
      if (byId[e.id]) carts[f].unshift(cartCopy(byId[e.id], e.cab, before[f + '|' + e.id] || 0));
    });
  }
  /** Shows the server's cart plus this device's unsent changes. Older answers than the one shown are ignored. */
  function applyCartState(st, force) {
    if (!sync.on || !st || typeof st.rev !== 'number') return;
    if (st.rev < sync.rev) return;
    if (st.rev === sync.rev && !force && !sync.ops.length) return;
    var first = sync.rev < 0;
    sync.rev = st.rev;
    var byId = {}; state.items.forEach(function (x) { byId[x.id] = x; });
    var before = {};
    Object.keys(carts).forEach(function (f) { carts[f].forEach(function (x) { before[f + '|' + x.id] = x._at || 0; }); });
    var unknown = 0, now = Date.now();
    Object.keys(carts).forEach(function (f) {
      carts[f] = (((st.carts || {})[f]) || []).map(function (e) {
        var x = byId[e.id];
        if (!x) { unknown++; return null; }
        var k = f + '|' + e.id;
        return cartCopy(x, e.cab, k in before ? before[k] : (first ? 0 : now)); // arrivals from another device flash like a scan
      }).filter(Boolean);
    });
    groupTarget = st.target || '';
    sync.ops.forEach(function (op) { applyOpLocal(op, byId, before); });
    if (groupTarget && !state.containers.some(function (c) { return c.cabinetId === groupTarget; })) unknown++;
    var sel = $('groupTarget');
    if (sel && !unknown) sel.value = groupTarget;
    renderCart();
    if (flow === 'group') renderGroupPick();
    if (unknown && !sync.refetching) {
      // Another device scanned something this one has not loaded yet: read the sheet, then show it again.
      sync.refetching = true;
      refreshQuiet().then(function () {
        sync.refetching = false;
        if (sync.rev === st.rev) { sync.rev = st.rev - 1; applyCartState(st, true); }
      });
    }
  }
  function pollCart() {
    if (!sync.on || !session || !state.me || sync.busy || sync.ops.length || sync.polling) return;
    sync.polling = true;
    sync.lastPoll = Date.now();
    api('cart.get', {}, { silent: true }).then(function (st) {
      sync.polling = false;
      applyCartState(st);
      if (st && st.dataRev) {
        // Something was saved elsewhere (a check-out from a phone): re-read the sheet so stats and history match.
        if (sync.dataRev && st.dataRev !== sync.dataRev) refreshQuiet();
        sync.dataRev = st.dataRev;
      }
    }, function () { sync.polling = false; });
  }
  /** Every 3 s on the Scan page, every 15 s elsewhere, never while the tab is hidden. */
  function syncTick() {
    if (!sync.on || !session || document.hidden) return;
    if (Date.now() - sync.lastPoll < (page === 'scan' ? 3000 : 15000)) return;
    pollCart();
  }

  function renderCart() {
    Object.keys(FLOWS).forEach(function (f) {
      $('count-' + f).textContent = carts[f].length + ' ' + FLOWS[f].unit;
      var tab = document.querySelector('#flowTabs [data-flow="' + f + '"]');
      if (tab) tab.classList.toggle('has', carts[f].length > 0);
    });
    var cart = carts[flow];
    $('cartTitle').textContent = FLOWS[flow].title + ' · ' + cart.length;
    var byType = {};
    cart.forEach(function (x) { byType[x.type] = (byType[x.type] || 0) + 1; });
    $('cartSummary').textContent = cart.length ? Object.keys(byType).map(function (t) { return byType[t] + ' ' + typeLabel(t); }).join(' · ') : '';
    $('saveBtn').disabled = !cart.length;
    $('saveBtn').textContent = flow === 'group' ? 'Simpan ' + cart.length + ' aset ke wadah' : 'Simpan ' + cart.length + ' unit';
    persistCarts();
    if (!cart.length) { $('cartList').innerHTML = '<div class="empty">Belum ada barang. Scan QR, ketik ID, atau pilih dari daftar inventaris.</div>'; return; }
    var now = Date.now();
    $('cartList').innerHTML = cart.map(function (x) {
      var cab = x._cartCabinetId || x.cabinetId;
      var fresh = now - (x._at || 0) < 1500 ? ' new' : '';
      return '<div class="item' + fresh + '"><div class="info"><strong>' + esc(x.id) + '</strong><div class="meta">' + esc(x.name) + ' · ' + esc(typeLabel(x.type)) +
        ' ' + pillStatus(x.locationStatus) + (cab ? ' <span class="pill">' + esc(cab) + '</span>' : '') + '</div></div>' +
        '<div class="ops"><button class="btn secondary small" type="button" data-remove="' + esc(x.id) + '">Hapus</button></div></div>';
    }).join('');
  }

  // ---------- saving: Simpan opens one sheet with the details and the confirm ----------

  function saveFlow() {
    var cart = carts[flow];
    if (!cart.length) { toast('Keranjang kosong. Scan atau pilih barang dulu.', true); return; }
    if (flow === 'group') return saveGroup('assign');
    var dr = drafts[flow] || {};
    var n = cart.length;
    var shownIds = cart.map(function (x) { return x.id; });
    var fields = '';
    if (flow === 'check') {
      fields = '<label>Hasil pemeriksaan *</label><select name="condition"><option value="BAIK"' + (dr.condition === 'BAIK' || !dr.condition ? ' selected' : '') + '>BAIK</option><option value="RUSAK"' + (dr.condition === 'RUSAK' ? ' selected' : '') + '>RUSAK</option></select>' +
        '<div id="damageWrap"' + (dr.condition === 'RUSAK' ? '' : ' class="hidden"') + '><label>Keterangan kerusakan *</label><textarea name="damageNote" placeholder="Contoh: pixel mati, power tidak menyala, casing retak">' + esc(dr.damageNote || '') + '</textarea></div>' +
        '<label>Catatan umum (opsional)</label><textarea name="note">' + esc(dr.note || '') + '</textarea>' +
        '<p class="small muted" style="margin-top:10px">Hasil ini berlaku untuk semua ' + n + ' unit di keranjang.</p>';
    } else {
      var isOut = flow === 'out';
      fields = '<div class="formgrid">' +
        '<div><label>Tanggal *</label><input name="eventDate" type="date" value="' + esc(dr.eventDate || today()) + '"></div>' +
        '<div><label>Nama acara / proyek</label><input name="eventName" value="' + esc(dr.eventName || '') + '" placeholder="Contoh: Konser / Seminar"></div>' +
        '<div class="full"><label>' + (isOut ? 'Lokasi pemasangan / tujuan *' : 'Lokasi asal / acara *') + '</label><input name="location" value="' + esc(dr.location || '') + '" placeholder="' + (isOut ? 'Contoh: Ballroom Hotel ABC' : 'Contoh: Ballroom Hotel ABC') + '"></div>' +
        (isOut ? '' : '<div class="full"><label>Disimpan di</label><input name="storeLocation" value="' + esc(dr.storeLocation || 'Gudang') + '" placeholder="Contoh: Gudang Kubik"></div>') +
        '<div class="full"><label>Catatan umum (opsional)</label><textarea name="note">' + esc(dr.note || '') + '</textarea></div></div>';
    }
    var d = openDialog('<form><h2>' + esc(FLOW_NAMES[flow]) + ' · ' + n + ' unit</h2>' + fields +
      '<div class="actions"><button class="btn secondary" type="button" data-r="0">Batal</button><button class="btn success" type="submit">Simpan ' + n + ' unit</button></div></form>');
    var form = d.querySelector('form');
    var cond = form.querySelector('[name=condition]');
    if (cond) cond.addEventListener('change', function () { form.querySelector('#damageWrap').classList.toggle('hidden', cond.value !== 'RUSAK'); });
    d.querySelector('[data-r="0"]').addEventListener('click', closeDialog);
    var first = form.querySelector('input[name=location], select'); if (first) first.focus();
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var f = {};
      new FormData(form).forEach(function (v, k) { f[k] = String(v).trim(); });
      if (flow === 'check') {
        if (f.condition === 'RUSAK' && !f.damageNote) { toast('Keterangan kerusakan wajib diisi.', true); form.querySelector('[name=damageNote]').focus(); return; }
      } else {
        if (!f.eventDate) { toast('Tanggal wajib diisi.', true); form.querySelector('[name=eventDate]').focus(); return; }
        if (!f.location) { toast('Lokasi wajib diisi.', true); form.querySelector('[name=location]').focus(); return; }
      }
      drafts[flow] = f;
      persistCarts();
      closeDialog();
      commitFlow(f, shownIds);
    });
  }

  function commitFlow(f, shownIds) {
    var thisFlow = flow;
    // Send any scans still queued first, so the server's shared cart holds everything on this screen.
    flushOps().then(function () {
      var shown = {}; (shownIds || []).forEach(function (id) { shown[id] = true; });
      var cart = carts[thisFlow].filter(function (x) { return !shownIds || shown[x.id]; });
      if (!cart.length) { toast('Keranjang sudah kosong; mungkin sudah disimpan dari perangkat lain.', true); return; }
      var payload = { action: FLOWS[thisFlow].action, ids: cart.map(function (x) { return x.id; }), note: f.note || '' };
      payload.cabinetIds = cart.map(function (x) { return x._cartCabinetId; }).filter(function (v, i, a) { return v && a.indexOf(v) === i; });
      payload.fromCart = sync.on && !sync.ops.length;
      if (thisFlow === 'check') { payload.condition = f.condition; payload.damageNote = f.condition === 'RUSAK' ? f.damageNote : ''; }
      else { payload.eventDate = f.eventDate; payload.location = f.location; payload.eventName = f.eventName || ''; if (thisFlow === 'in') payload.storeLocation = f.storeLocation || ''; }
      pendingBatch[thisFlow] = pendingBatch[thisFlow] || uuid();
      api('commit', payload, { batchId: pendingBatch[thisFlow], loadingText: 'Menyimpan ' + cart.length + ' unit...' }).then(function (d) {
        delete pendingBatch[thisFlow];
        var saved = {}; payload.ids.forEach(function (id) { saved[id] = true; });
        carts[thisFlow] = carts[thisFlow].filter(function (x) { return !saved[x.id]; });
        drafts[thisFlow] = thisFlow === 'check' ? { condition: 'BAIK' } : {};
        applySnapshot(d);
        if (d.cart) applyCartState(d.cart, true);
        toast(d.message || 'Tersimpan.');
        scanStatus('Tersimpan. Siap scan berikutnya.', 'ok');
        buzz(true);
      }).catch(function (e) {
        if (e.invalid && e.invalid.length) {
          var bad = {}; e.invalid.forEach(function (id) { bad[id.toLowerCase()] = true; });
          var dropped = carts[thisFlow].filter(function (x) { return bad[x.id.toLowerCase()]; }).map(function (x) { return x.id; });
          carts[thisFlow] = carts[thisFlow].filter(function (x) { return !bad[x.id.toLowerCase()]; });
          if (dropped.length) queueOp({ op: 'remove', flow: thisFlow, ids: dropped });
          renderCart();
          toast(e.message + (carts[thisFlow].length ? ' Barang itu dikeluarkan dari keranjang; tekan Simpan lagi.' : ''), true);
        } else toast(e.message, true);
      });
    });
  }

  function saveGroup(mode) {
    var cart = carts.group;
    if (!cart.length) { toast('Keranjang kosong.', true); return; }
    if (mode === 'assign' && !groupTarget) { toast('Pilih atau scan kabinet/box tujuan dulu.', true); return; }
    var ids = cart.map(function (x) { return x.id; });
    var title = mode === 'assign' ? 'Masukkan ' + ids.length + ' aset ke ' + groupTarget + '?' : 'Lepas ' + ids.length + ' aset dari wadahnya?';
    var text = mode === 'assign' ? 'Aset yang sudah ada di wadah lain akan dipindahkan.' : 'Relasi kabinet/box dihapus; aset tetap aktif.';
    confirmDialog(title, text, mode === 'assign' ? 'Simpan' : 'Lepas', mode !== 'assign').then(function (yes) {
      if (!yes) return null;
      return flushOps().then(function () { return true; });
    }).then(function (yes) {
      if (!yes) return;
      var key = 'group-' + mode;
      pendingBatch[key] = pendingBatch[key] || uuid();
      var call = mode === 'assign' ? api('container.assign', { cabinetId: groupTarget, ids: ids }, { batchId: pendingBatch[key], loadingText: 'Menyimpan...' })
        : api('container.unassign', { ids: ids }, { batchId: pendingBatch[key], loadingText: 'Menyimpan...' });
      call.then(function (d) {
        delete pendingBatch[key];
        var saved = {}; ids.forEach(function (id) { saved[id] = true; });
        carts.group = carts.group.filter(function (x) { return !saved[x.id]; });
        applySnapshot(d);
        if (d.cart) applyCartState(d.cart, true);
        toast(d.message || 'Tersimpan.');
        buzz(true);
      }).catch(function (e) {
        if (e.invalid && e.invalid.length) {
          var bad = {}; e.invalid.forEach(function (id) { bad[id.toLowerCase()] = true; });
          var dropped = carts.group.filter(function (x) { return bad[x.id.toLowerCase()]; }).map(function (x) { return x.id; });
          carts.group = carts.group.filter(function (x) { return !bad[x.id.toLowerCase()]; });
          if (dropped.length) queueOp({ op: 'remove', flow: 'group', ids: dropped });
          renderCart();
        }
        toast(e.message, true);
      });
    });
  }

  function renderGroupTarget() {
    var sel = $('groupTarget');
    sel.innerHTML = '<option value="">Pilih kabinet / box</option>' + state.containers.map(function (c) {
      return '<option value="' + esc(c.cabinetId) + '">' + esc(c.containerType === 'BOX' ? 'Box' : 'Kabinet') + ' · ' + esc(c.cabinetId) + ' — ' + esc(c.name) + ' (' + c.itemCount + ')</option>';
    }).join('');
    if (groupTarget && !state.containers.some(function (c) { return c.cabinetId === groupTarget; })) groupTarget = '';
    sel.value = groupTarget;
  }

  function groupPickMatches() {
    var q = $('groupSearch').value.trim().toLowerCase();
    var inCart = {}; carts.group.forEach(function (x) { inCart[x.id] = true; });
    return state.items.filter(function (x) {
      if (inCart[x.id]) return false;
      if (!q) return true;
      return [x.id, x.name, x.category, x.type, x.cabinetId].join(' ').toLowerCase().indexOf(q) >= 0;
    });
  }
  function renderGroupPick() {
    if (flow !== 'group') return;
    lazyList($('groupPickList'), groupPickMatches(), function (x) {
      return '<div class="item"><div class="info"><strong>' + esc(x.id) + '</strong><div class="meta">' + esc(x.name) + ' · ' + esc(typeLabel(x.type)) +
        (x.cabinetId ? ' <span class="pill cab">' + esc(x.cabinetId) + '</span>' : ' <span class="muted">belum ada wadah</span>') + '</div></div>' +
        '<div class="ops"><button class="btn secondary small" type="button" data-pick="' + esc(x.id) + '">+ Tambah</button></div></div>';
    }, { chunk: 40, empty: '<div class="empty">Tidak ada aset yang cocok.</div>' });
  }

  // ---------- rendering ----------

  function pillCondition(c) {
    if (c === 'BAIK') return '<span class="pill good">BAIK</span>';
    if (c === 'RUSAK') return '<span class="pill bad">RUSAK</span>';
    return '<span class="pill">BELUM DICEK</span>';
  }
  function pillStatus(s) { return s === 'DI LUAR' ? '<span class="pill out">DI LUAR</span>' : '<span class="pill good">DI GUDANG</span>'; }
  function actionPill(a) {
    var cls = { KELUAR: 'out', MASUK: 'good', INSPEKSI: 'cab', KELOMPOK: 'gold', LEPAS: 'gold' }[a] || 'plain';
    return '<span class="pill ' + cls + '">' + esc(ACTION_LABEL[a] || a) + '</span>';
  }

  function renderAll() {
    renderHome();
    renderInventory();
    renderContainers();
    renderGroupTarget();
    renderHistory();
    renderLabels();
    renderCart();
    renderGroupPick();
  }

  function renderHome() {
    var s = state.stats || {};
    var cards = [['Total unit aktif', s.total, ''], ['Kondisi baik', s.good, 'ok'], ['Kondisi rusak', s.damaged, s.damaged ? 'bad' : ''], ['Belum dicek', s.unchecked, ''],
      ['Sedang di luar', s.out, s.out ? 'hot' : ''], ['Tersedia di gudang', s.inWarehouse, ''], ['Kabinet / Box', s.boxes, '']];
    $('statCards').innerHTML = cards.map(function (c) {
      return '<div class="card ' + c[2] + '"><div class="label">' + c[0] + '</div><div class="num">' + Number(c[1] || 0).toLocaleString('id-ID') + '</div></div>';
    }).join('');
    var groups = groupTxns(state.transactions).slice(0, 8);
    $('homeRecent').innerHTML = groups.length ? groups.map(batchRow).join('') : '<div class="empty">Belum ada transaksi.</div>';
  }

  /** One row per save. Rows share a batch id; old rows without one are grouped by what they have in common. */
  function groupTxns(rows) {
    var out = [], cur = null;
    rows.forEach(function (t) {
      var key = t.batch_id ? 'b:' + t.batch_id : 'k:' + [t.action, t.ts, t.user, t.event_date, t.location, t.event_name, t.condition, t.damage_note].join('|');
      if (!cur || cur.key !== key) { cur = { key: key, action: t.action, first: t, items: [] }; out.push(cur); }
      cur.items.push(t);
    });
    return out;
  }
  function batchRow(g) {
    var t = g.first, n = g.items.length;
    var where = [t.location, t.event_name].filter(Boolean).join(' · ');
    var what = n === 1 ? esc(t.item_id) : n + ' unit';
    var detail = '';
    if (g.action === 'INSPEKSI') detail = pillCondition(t.condition) + (t.damage_note ? '<span class="muted">' + esc(t.damage_note) + '</span>' : '');
    else if (g.action === 'KELOMPOK' || g.action === 'LEPAS') detail = t.cabinet_id ? '<span class="pill cab">' + esc(t.cabinet_id) + '</span>' : '';
    else if (where) detail = '<span>' + esc(where) + '</span>';
    if (t.note && g.action !== 'INSPEKSI') detail += '<span class="muted">' + esc(t.note) + '</span>';
    var when = shortDate(t.event_date || t.ts) + (hhmm(t.ts) ? ' ' + hhmm(t.ts) : '');
    var types = {}; g.items.forEach(function (x) { types[x.item_type] = (types[x.item_type] || 0) + 1; });
    var typeLine = Object.keys(types).map(function (k) { return types[k] + ' ' + typeLabel(k); }).join(' · ');
    return '<details class="batch"><summary><div class="info"><div class="line1">' + actionPill(g.action) + '<strong>' + what + '</strong><span class="muted">' + esc(typeLine) + '</span></div>' +
      '<div class="meta">' + detail + '</div></div><div class="when"><span>' + esc(when) + '</span><span class="muted">' + esc(t.user) + '</span></div>' + ICON.chev + '</summary>' +
      '<div class="rows">' + g.items.map(function (x) {
        return '<div class="rowline"><strong>' + esc(x.item_id) + '</strong><span class="muted">' + esc(x.item_name) + (x.cabinet_id ? ' · ' + esc(x.cabinet_id) : '') + '</span></div>';
      }).join('') + '</div></details>';
  }
  function txnLine(t) {
    var where = [t.location, t.event_name].filter(Boolean).join(' · ');
    var detail = t.action === 'INSPEKSI' ? pillCondition(t.condition) + (t.damage_note ? '<span class="muted">' + esc(t.damage_note) + '</span>' : '')
      : (t.cabinet_id && (t.action === 'KELOMPOK' || t.action === 'LEPAS') ? '<span class="pill cab">' + esc(t.cabinet_id) + '</span>' : (where ? '<span>' + esc(where) + '</span>' : ''));
    if (t.note && t.action !== 'INSPEKSI') detail += '<span class="muted">' + esc(t.note) + '</span>';
    return '<div class="item"><div class="info"><div class="line1">' + actionPill(t.action) + '<strong>' + esc(shortDate(t.event_date || t.ts)) + '</strong><span class="muted">' + esc(hhmm(t.ts)) + ' · ' + esc(t.user) + '</span></div><div class="meta">' + detail + '</div></div></div>';
  }

  function inventoryMatches() {
    var q = $('inventorySearch').value.trim().toLowerCase();
    var f = inventoryFilter;
    return state.items.filter(function (x) {
      if (f === 'in' && x.locationStatus === 'DI LUAR') return false;
      if (f === 'out' && x.locationStatus !== 'DI LUAR') return false;
      if (f === 'damaged' && x.condition !== 'RUSAK') return false;
      if (f === 'unchecked' && x.condition) return false;
      if (f === 'nocabinet' && x.cabinetId) return false;
      if (!q) return true;
      return [x.id, x.name, x.category, x.type, x.cabinetId, x.location].join(' ').toLowerCase().indexOf(q) >= 0;
    });
  }
  function renderInventory() {
    var list = inventoryMatches();
    $('inventoryCount').textContent = list.length + ' dari ' + state.items.length + ' unit aktif';
    lazyList($('inventoryList'), list, itemRow, { empty: '<div class="empty">Tidak ada barang yang cocok.</div>' });
  }
  function itemRow(x) {
    return '<div class="item tap" data-open="' + esc(x.id) + '" role="button" tabindex="0"><div class="info"><strong>' + esc(x.id) + '</strong><div>' + esc(x.name) +
      ' <span class="muted">· ' + esc(typeLabel(x.type)) + (x.category ? ' · ' + esc(x.category) : '') + '</span></div>' +
      '<div class="meta">' + pillCondition(x.condition) + pillStatus(x.locationStatus) + '<span>' + esc(x.location) + '</span>' +
      (x.cabinetId ? '<span class="pill cab">' + esc(x.cabinetId) + '</span>' : '') + (x.damageNote ? '<span class="muted">' + esc(x.damageNote) + '</span>' : '') + '</div></div>' + ICON.chev + '</div>';
  }
  /** Tap a row: one sheet with everything you can do with the item. The likely action is the white one. */
  function itemSheet(id) {
    var x = state.items.filter(function (i) { return i.id === id; })[0];
    if (!x) return;
    var admin = state.me && state.me.role === 'admin';
    var isOut = x.locationStatus === 'DI LUAR';
    var d = openDialog('<div class="sheet-head"><div><h2 style="margin:0">' + esc(x.id) + '</h2><div>' + esc(x.name) + ' <span class="muted">· ' + esc(typeLabel(x.type)) + (x.category ? ' · ' + esc(x.category) : '') + '</span></div>' +
      '<div class="meta">' + pillCondition(x.condition) + pillStatus(x.locationStatus) + '<span>' + esc(x.location) + '</span>' + (x.cabinetId ? '<span class="pill cab">' + esc(x.cabinetId) + '</span>' : '') + '</div>' +
      (x.damageNote ? '<p class="small muted" style="margin:6px 0 0">' + esc(x.damageNote) + '</p>' : '') +
      (x.lastUser ? '<p class="small muted" style="margin:6px 0 0">Terakhir: ' + esc(x.updatedAt) + ' oleh ' + esc(x.lastUser) + '</p>' : '') + '</div></div>' +
      '<div class="sheet-grid">' +
      '<button class="btn ' + (isOut ? 'secondary' : '') + '" type="button" data-a="out"' + (isOut ? ' disabled' : '') + '>' + ICON.out + 'Barang Keluar</button>' +
      '<button class="btn ' + (isOut ? '' : 'secondary') + '" type="button" data-a="in"' + (isOut ? '' : ' disabled') + '>' + ICON.inn + 'Barang Masuk</button>' +
      '<button class="btn secondary" type="button" data-a="check">' + ICON.check + 'Pengecekan Kondisi</button>' +
      '<button class="btn secondary" type="button" data-a="history">' + ICON.clock + 'Riwayat</button>' +
      (admin ? '<button class="btn secondary" type="button" data-a="edit">' + ICON.edit + 'Edit</button><button class="btn danger" type="button" data-a="deactivate">' + ICON.trash + 'Nonaktifkan</button>' : '') +
      '</div><button class="btn secondary block sheet-close" type="button" data-a="close">Tutup</button>');
    d.querySelectorAll('[data-a]').forEach(function (b) {
      b.addEventListener('click', function () {
        var a = b.dataset.a;
        closeDialog();
        if (a === 'check' || a === 'out' || a === 'in') {
          setFlow(a);
          var added = pushCart(x, a, '');
          showPage('scan');
          toast(added ? x.id + ' masuk keranjang ' + FLOW_NAMES[a] + '.' : x.id + ' sudah ada di keranjang.', !added);
        }
        if (a === 'history') showHistory(x.id);
        if (a === 'edit') editItem(x.id);
        if (a === 'deactivate') deactivateItem(x.id);
      });
    });
  }

  function renderContainers() {
    lazyList($('containerList'), state.containers, containerRow, { empty: '<div class="empty">Belum ada kabinet/box. Tambah wadah dulu, lalu kelompokkan asetnya lewat Scan › Kelompokkan.</div>' });
  }
  function containerRow(c) {
    return '<div class="item tap" data-copen="' + esc(c.cabinetId) + '" role="button" tabindex="0"><div class="info"><strong>' + esc(c.cabinetId) + ' <span class="pill gold">' + (c.containerType === 'BOX' ? 'Box' : 'Kabinet') + '</span></strong>' +
      '<div>' + esc(c.name) + (c.category ? ' <span class="muted">· ' + esc(c.category) + '</span>' : '') + '</div>' +
      '<div class="meta"><span>' + c.itemCount + ' aset</span>' + (c.damagedCount ? '<span class="pill bad">' + c.damagedCount + ' rusak</span>' : '') +
      (c.outCount ? '<span class="pill out">' + c.outCount + ' di luar</span>' : '') + (c.note ? '<span class="muted">' + esc(c.note) + '</span>' : '') + '</div></div>' + ICON.chev + '</div>';
  }
  function containerSheet(cid) {
    var c = state.containers.filter(function (k) { return k.cabinetId === cid; })[0];
    if (!c) return;
    var dis = c.itemCount ? '' : ' disabled';
    var primary = !c.itemCount ? 'group' : (c.outCount === 0 ? 'out' : (c.outCount === c.itemCount ? 'in' : 'group'));
    var cls = function (a) { return a === primary ? 'btn' : 'btn secondary'; };
    var d = openDialog('<div class="sheet-head"><div><h2 style="margin:0">' + esc(c.cabinetId) + '</h2><div>' + esc(c.name) + ' <span class="muted">· ' + (c.containerType === 'BOX' ? 'Box' : 'Kabinet') + (c.category ? ' · ' + esc(c.category) : '') + '</span></div>' +
      '<div class="meta"><span>' + c.itemCount + ' aset</span>' + (c.damagedCount ? '<span class="pill bad">' + c.damagedCount + ' rusak</span>' : '') + (c.outCount ? '<span class="pill out">' + c.outCount + ' di luar</span>' : '') + '</div>' +
      (c.note ? '<p class="small muted" style="margin:6px 0 0">' + esc(c.note) + '</p>' : '') + '</div></div>' +
      '<div class="sheet-grid">' +
      '<button class="' + cls('group') + ' full" type="button" data-a="group">' + ICON.box + 'Kelompokkan aset ke sini</button>' +
      '<button class="' + cls('out') + '" type="button" data-a="out"' + dis + '>' + ICON.out + 'Keluarkan semua isi</button>' +
      '<button class="' + cls('in') + '" type="button" data-a="in"' + dis + '>' + ICON.inn + 'Masukkan semua isi</button>' +
      '<button class="btn secondary" type="button" data-a="check"' + dis + '>' + ICON.check + 'Cek semua isi</button>' +
      '<button class="btn secondary" type="button" data-a="edit">' + ICON.edit + 'Edit</button>' +
      '</div><button class="btn secondary block sheet-close" type="button" data-a="close">Tutup</button>');
    d.querySelectorAll('[data-a]').forEach(function (b) {
      b.addEventListener('click', function () {
        var a = b.dataset.a;
        closeDialog();
        if (a === 'check' || a === 'out' || a === 'in') addContainerToCart(cid, a);
        if (a === 'group') { clearCart('group'); setGroupTarget(cid); goScan('group'); $('groupTarget').value = groupTarget; renderGroupPick(); }
        if (a === 'edit') editContainer(cid);
      });
    });
  }

  function historyMatches() {
    var q = $('historySearch').value.trim().toLowerCase();
    var a = $('historyAction').value;
    return state.transactions.filter(function (t) {
      if (a && t.action !== a) return false;
      if (!q) return true;
      return [t.item_id, t.item_name, t.event_name, t.location, t.user, t.cabinet_id, t.note, t.batch_id].join(' ').toLowerCase().indexOf(q) >= 0;
    });
  }
  function renderHistory() {
    var rows = historyMatches();
    var groups = groupTxns(rows);
    $('historyCount').textContent = groups.length + ' penyimpanan, ' + rows.length + ' baris, dari ' + state.transactions.length + ' baris terakhir yang dimuat. Riwayat lengkap ada di sheet.';
    lazyList($('historyTable'), groups, batchRow, { chunk: 40, empty: '<div class="empty">Belum ada riwayat.</div>' });
  }

  function showHistory(id) {
    api('history', { itemId: id }, { loadingText: 'Memuat riwayat ' + id }).then(function (d) {
      var rows = d.transactions || [];
      openDialog('<h2>Riwayat ' + esc(id) + '</h2>' + (rows.length ? '<div class="list" style="max-height:60vh;overflow:auto">' + rows.map(txnLine).join('') + '</div>' : '<div class="empty">Belum ada riwayat.</div>') +
        '<div class="actions"><button class="btn secondary" type="button" id="dlgClose">Tutup</button></div>');
      $('dlgClose').addEventListener('click', closeDialog);
    }).catch(function (e) { toast(e.message, true); });
  }

  function editItem(id) {
    var x = state.items.filter(function (i) { return i.id === id; })[0];
    if (!x) return;
    var types = state.types.map(function (t) { return '<option value="' + esc(t) + '"' + (t === x.type ? ' selected' : '') + '>' + esc(typeLabel(t)) + '</option>'; }).join('');
    formDialog('Edit ' + x.id,
      '<label>Nama barang *</label><input name="name" required value="' + esc(x.name) + '">' +
      '<label>Jenis</label><select name="type">' + types + '</select>' +
      '<label>Kategori</label><input name="category" value="' + esc(x.category) + '">' +
      '<label>Lokasi saat ini</label><input name="location" value="' + esc(x.location) + '">'
    ).then(function (f) {
      if (!f) return;
      f.id = id;
      api('item.update', f, { loadingText: 'Menyimpan...' }).then(function (d) { applySnapshot(d); toast(d.message); }).catch(function (e) { toast(e.message, true); });
    });
  }

  function deactivateItem(id) {
    confirmDialog('Nonaktifkan ' + id + '?', 'Barang hilang dari inventaris aktif, riwayatnya tetap tersimpan di sheet.', 'Nonaktifkan', true).then(function (yes) {
      if (!yes) return;
      api('item.deactivate', { ids: [id] }, { batchId: uuid(), loadingText: 'Menyimpan...' }).then(function (d) { applySnapshot(d); toast(d.message); }).catch(function (e) { toast(e.message, true); });
    });
  }

  function editContainer(cid) {
    var c = state.containers.filter(function (k) { return k.cabinetId === cid; })[0];
    if (!c) return;
    formDialog('Edit ' + c.cabinetId,
      '<label>Nama *</label><input name="name" required value="' + esc(c.name) + '">' +
      '<label>Kategori</label><input name="category" value="' + esc(c.category || '') + '">' +
      '<label>Catatan</label><input name="note" value="' + esc(c.note || '') + '">'
    ).then(function (f) {
      if (!f) return;
      f.cabinetId = cid;
      api('container.save', f, { loadingText: 'Menyimpan...' }).then(function (d) { applySnapshot(d); toast(d.message); }).catch(function (e) { toast(e.message, true); });
    });
  }

  function addContainerToCart(cid, f) {
    var members = state.items.filter(function (x) { return x.cabinetId === cid; });
    if (!members.length) { toast('Wadah ' + cid + ' belum punya aset aktif.', true); return; }
    var added = 0;
    setFlow(f);
    members.forEach(function (m) { if (pushCart(m, f, cid)) added++; });
    showPage('scan');
    toast(added + ' aset dari ' + cid + ' masuk ke keranjang.');
  }

  // ---------- scan to look up: point at a label, get its sheet ----------

  function lookupScan() {
    if (!window.Html5Qrcode) { toast('Pustaka kamera tidak termuat.', true); return; }
    ensureAudio();
    var d = openDialog('<h2>Scan untuk mencari</h2><p class="small muted">Arahkan ke label barang atau box.</p>' +
      '<div class="viewfinder" id="lookupView"><div id="lookupReader"></div><div class="corners"><i></i></div></div>' +
      '<div class="row" style="margin-top:12px"><input id="lookupInput" placeholder="Atau ketik ID" autocomplete="off" autocapitalize="off"><button class="btn" type="button" id="lookupGo">Cari</button></div>' +
      '<div class="actions"><button class="btn secondary block" type="button" id="lookupClose">Tutup</button></div>', stopLookup);
    var done = false;
    function found(code) {
      if (done) return; done = true;
      resolveCode(String(code || '').trim()).then(function (hit) {
        closeDialog();
        buzz(true);
        if (hit.item) itemSheet(hit.item.id); else if (hit.container) containerSheet(hit.container.cabinetId);
      }).catch(function (e) { done = false; buzz(false); toast(e.message, true); });
    }
    $('lookupClose').addEventListener('click', closeDialog);
    $('lookupGo').addEventListener('click', function () { found($('lookupInput').value); });
    $('lookupInput').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); found($('lookupInput').value); } });
    d.addEventListener('cancel', function () { stopLookup(); }, { once: true });
    try {
      lookupScanner = makeScanner('lookupReader');
      lookupScanner.start({ facingMode: 'environment' }, SCAN_CONFIG, function (text) { found(text); }, function () { /* nothing yet */ })
        .then(function () { $('lookupView').classList.add('on'); })
        .catch(function (err) { var inp = $('lookupInput'); if (!inp) return; toast('Kamera tidak bisa dibuka: ' + ((err && err.message) || err) + '. Ketik ID di bawah.', true); inp.focus(); });
    } catch (err) { toast('Kamera tidak tersedia. Ketik ID di bawah.', true); }
  }
  function stopLookup() {
    if (!lookupScanner) return;
    var s = lookupScanner; lookupScanner = null;
    try { s.stop().then(function () { s.clear(); }).catch(function () { /* not running */ }); } catch (e) { /* ignore */ }
  }

  // ---------- labels ----------

  function labelMatches() {
    var q = $('labelSearch').value.trim().toLowerCase();
    return state.items.filter(function (x) { return !q || [x.id, x.name, x.category, x.type].join(' ').toLowerCase().indexOf(q) >= 0; });
  }
  function renderLabels() {
    var list = labelMatches();
    $('labelCount').textContent = Object.keys(labelSelected).length + ' dipilih · ' + list.length + ' hasil';
    lazyList($('labelList'), list, function (x) {
      return '<label class="item" style="margin:0;font-weight:400;font-size:14px;color:inherit;cursor:pointer"><input type="checkbox" data-label="' + esc(x.id) + '"' + (labelSelected[x.id] ? ' checked' : '') + '>' +
        '<div class="info"><strong>' + esc(x.id) + '</strong><div class="meta">' + esc(x.name) + ' · ' + esc(typeLabel(x.type)) + '</div></div></label>';
    }, { empty: '<div class="empty">Tidak ada barang.</div>' });
  }
  function qrSvg(text) {
    var qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    var n = qr.getModuleCount(), d = '';
    for (var r = 0; r < n; r++) for (var c = 0; c < n; c++) if (qr.isDark(r, c)) d += 'M' + c + ' ' + r + 'h1v1h-1z';
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + n + ' ' + n + '" shape-rendering="crispEdges"><rect width="' + n + '" height="' + n + '" fill="#fff"/><path d="' + d + '" fill="#000"/></svg>';
  }
  function printLabels() {
    var items = state.items.filter(function (x) { return labelSelected[x.id]; });
    if (!items.length) { toast('Pilih minimal satu barang.', true); return; }
    var area = $('printArea');
    var paper = $('labelPaper').value === 'sheet' ? 'sheet' : 'roll';
    try { localStorage.setItem(LABEL_KEY, JSON.stringify({ paper: paper, size: $('labelSize').value })); } catch (e) { /* ignore */ }
    area.className = 'qrgrid ' + paper + ' size-' + $('labelSize').value;
    area.innerHTML = items.map(function (x) {
      // Long IDs may break only after - . / _ so a narrow label never splits them letter by letter.
      var id = esc(x.id).replace(/([-.\/_])/g, '$1<wbr>');
      return '<div class="qrcard">' + qrSvg(x.qrValue || x.id) + '<div class="txt"><strong>' + id + '</strong><small>' + esc(x.name) + ' · ' + esc(typeLabel(x.type)) + '</small></div></div>';
    }).join('');
    $('toast').className = 'toast';
    setTimeout(function () { window.print(); }, 150);
  }

  // ---------- import and containers forms ----------

  function importDialog() {
    var types = state.types.map(function (t) { return '<option value="' + esc(t) + '">' + esc(typeLabel(t)) + '</option>'; }).join('');
    formDialog('Tambah Aset',
      '<p class="small muted">Untuk ID yang sudah tercetak di label. Satu ID per baris; ID dipertahankan apa adanya dan menjadi isi QR. Maksimal 2.000 ID per proses, duplikat dilewati.</p>' +
      '<label>Jenis barang *</label><select name="type" required>' + types + '</select>' +
      '<label>Nama barang *</label><input name="name" required placeholder="Contoh: Modul LED P2.9">' +
      '<label>Kategori</label><input name="category" placeholder="Contoh: LED Screen">' +
      '<label>Lokasi awal</label><input name="location" value="Gudang">' +
      '<label>Daftar ID *</label><textarea name="ids" rows="7" required placeholder="1-MVG-12-25-NY-MD.001&#10;1-MVG-12-25-NY-MD.002"></textarea>',
      'Tambah aset'
    ).then(function (f) {
      if (!f) return;
      var ids = f.ids.split(/[\n\r\t,;]+/).map(function (v) { return v.trim(); }).filter(Boolean);
      if (!ids.length) { toast('Tempelkan minimal satu ID.', true); return; }
      if (ids.length > 2000) { toast('Maksimal 2.000 ID per proses.', true); return; }
      confirmDialog('Tambah ' + ids.length + ' ID?', 'ID yang sudah ada akan dilewati.', 'Tambah').then(function (yes) {
        if (!yes) return;
        f.ids = ids;
        api('item.import', f, { batchId: uuid(), loadingText: 'Mendaftarkan ' + ids.length + ' ID...' }).then(function (d) {
          applySnapshot(d);
          toast(d.message);
          if (d.skippedCount) console.info('ID duplikat yang dilewati:', d.skipped);
        }).catch(function (err) { toast(err.message, true); });
      });
    });
  }

  function previewContainerId() {
    var type = $('containerType').value;
    var input = $('containerId');
    if (!type) { input.value = ''; return; }
    input.placeholder = 'Membuat ID otomatis...';
    api('container.nextId', { containerType: type }, { silent: true }).then(function (d) {
      if ($('containerType').value === type && !input.value) input.placeholder = d.cabinetId + ' (otomatis) — atau isi label box fisik';
    }).catch(function () { input.placeholder = 'Otomatis, atau isi label box fisik'; });
  }

  function submitContainer(e) {
    e.preventDefault();
    var form = e.target;
    var f = {};
    new FormData(form).forEach(function (v, k) { f[k] = String(v).trim(); });
    if (!f.containerType || !f.name) { toast('Pilih jenis wadah dan isi nama.', true); return; }
    f.createNew = true;
    api('container.save', f, { batchId: uuid(), loadingText: 'Menyimpan wadah...' }).then(function (d) {
      applySnapshot(d);
      form.reset();
      form.classList.add('hidden');
      toast(d.message);
    }).catch(function (err) { toast(err.message, true); });
  }

  // ---------- events ----------

  function bindEvents() {
    $('loginForm').addEventListener('submit', function (e) {
      e.preventDefault();
      session = { unit: $('loginUnit').value || (units[0] && units[0].key), user: $('loginUser').value.trim(), code: $('loginCode').value.trim() };
      $('loginError').classList.add('hidden');
      bootstrap();
    });
    $('menuBtn').addEventListener('click', function () {
      var d = openDialog('<h2>' + esc(state.me ? state.me.name : '') + '</h2><p class="muted small">' + esc(unitLabel()) + ' · ' + esc(location.host) + '</p>' +
        '<div class="actions" style="flex-direction:column"><button class="btn secondary" type="button" data-m="reload">Muat ulang data</button>' +
        '<button class="btn secondary" type="button" data-m="labels">Cetak label QR</button>' +
        '<button class="btn secondary" type="button" data-m="logout">Keluar</button><button class="btn" type="button" data-m="close">Tutup</button></div>');
      d.querySelectorAll('[data-m]').forEach(function (b) {
        b.addEventListener('click', function () {
          closeDialog();
          if (b.dataset.m === 'reload') refreshQuiet(true);
          if (b.dataset.m === 'labels') showPage('labels');
          if (b.dataset.m === 'logout') logout();
        });
      });
    });
    document.querySelectorAll('#nav button').forEach(function (b) { b.addEventListener('click', function () { showPage(b.dataset.page); }); });
    document.querySelectorAll('#sidebar .navbtn').forEach(function (b) {
      b.addEventListener('click', function () { if (b.dataset.flow) setFlow(b.dataset.flow); showPage(b.dataset.page); });
    });
    document.querySelectorAll('[data-go]').forEach(function (b) {
      b.addEventListener('click', function () { if (b.dataset.flow) setFlow(b.dataset.flow); showPage(b.dataset.go); });
    });
    document.querySelectorAll('#flowTabs button').forEach(function (b) { b.addEventListener('click', function () { setFlow(b.dataset.flow); }); });

    $('camStart').addEventListener('click', startCamera);
    $('camStop').addEventListener('click', function () { stopCamera(false); scanStatus('Kamera dihentikan.', ''); });
    $('scanAdd').addEventListener('click', function () { ensureAudio(); var v = $('scanInput').value; $('scanInput').value = ''; handleCode(v); $('scanInput').focus(); });
    $('scanInput').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); $('scanAdd').click(); } });
    $('cartClear').addEventListener('click', function () { clearCart(flow); renderGroupPick(); });
    $('cartList').addEventListener('click', function (e) { var b = e.target.closest('[data-remove]'); if (b) { removeFromCart(flow, b.dataset.remove); if (flow === 'group') renderGroupPick(); } });
    $('saveBtn').addEventListener('click', saveFlow);
    $('groupUnassign').addEventListener('click', function () { saveGroup('unassign'); });
    $('groupTarget').addEventListener('change', function () {
      var next = $('groupTarget').value;
      if (carts.group.length && groupTarget && next !== groupTarget) {
        confirmDialog('Ganti tujuan?', 'Keranjang berisi aset untuk ' + groupTarget + '. Kosongkan keranjang untuk ganti ke ' + (next || 'tujuan lain') + '?', 'Kosongkan', true).then(function (yes) {
          if (yes) { clearCart('group'); setGroupTarget(next); renderGroupPick(); } else $('groupTarget').value = groupTarget;
        });
        return;
      }
      setGroupTarget(next);
    });
    $('groupSearch').addEventListener('input', renderGroupPick);
    $('groupPickList').addEventListener('click', function (e) {
      var b = e.target.closest('[data-pick]'); if (!b) return;
      if (!groupTarget) { toast('Pilih kabinet/box tujuan dulu.', true); return; }
      var x = state.items.filter(function (i) { return i.id === b.dataset.pick; })[0];
      if (x && pushCart(x, 'group', '')) renderGroupPick();
    });
    $('groupAddAll').addEventListener('click', function () {
      if (!groupTarget) { toast('Pilih kabinet/box tujuan dulu.', true); return; }
      var list = groupPickMatches();
      if (list.length > 300) { toast('Terlalu banyak (' + list.length + '). Persempit pencarian dulu.', true); return; }
      list.forEach(function (x) { pushCart(x, 'group', ''); });
      renderGroupPick();
      toast(list.length + ' aset masuk keranjang.');
    });

    $('inventorySearch').addEventListener('input', renderInventory);
    $('inventoryFilter').addEventListener('click', function (e) {
      var b = e.target.closest('[data-f]'); if (!b) return;
      inventoryFilter = b.dataset.f;
      document.querySelectorAll('#inventoryFilter [data-f]').forEach(function (c) { c.classList.toggle('active', c === b); });
      renderInventory();
    });
    $('lookupScanBtn').addEventListener('click', lookupScan);
    $('inventoryList').addEventListener('click', function (e) { var r = e.target.closest('[data-open]'); if (r) itemSheet(r.dataset.open); });
    $('inventoryList').addEventListener('keydown', function (e) { if (e.key === 'Enter') { var r = e.target.closest('[data-open]'); if (r) itemSheet(r.dataset.open); } });
    $('importBtn').addEventListener('click', importDialog);

    $('containerFormToggle').addEventListener('click', function () { $('containerForm').classList.toggle('hidden'); previewContainerId(); });
    $('containerFormCancel').addEventListener('click', function () { $('containerForm').reset(); $('containerForm').classList.add('hidden'); });
    $('containerType').addEventListener('change', previewContainerId);
    $('containerForm').addEventListener('submit', submitContainer);
    $('containerList').addEventListener('click', function (e) { var r = e.target.closest('[data-copen]'); if (r) containerSheet(r.dataset.copen); });
    $('containerList').addEventListener('keydown', function (e) { if (e.key === 'Enter') { var r = e.target.closest('[data-copen]'); if (r) containerSheet(r.dataset.copen); } });

    $('historySearch').addEventListener('input', renderHistory);
    $('historyAction').addEventListener('change', renderHistory);

    $('labelSearch').addEventListener('input', renderLabels);
    $('labelList').addEventListener('change', function (e) {
      var cb = e.target.closest('[data-label]'); if (!cb) return;
      if (cb.checked) labelSelected[cb.dataset.label] = true; else delete labelSelected[cb.dataset.label];
      $('labelCount').textContent = Object.keys(labelSelected).length + ' dipilih · ' + labelMatches().length + ' hasil';
    });
    $('labelSelectAll').addEventListener('click', function () { labelMatches().forEach(function (x) { labelSelected[x.id] = true; }); renderLabels(); });
    $('labelClear').addEventListener('click', function () { labelSelected = {}; $('printArea').innerHTML = ''; renderLabels(); });
    $('labelPrint').addEventListener('click', printLabels);
    try {
      var lp = JSON.parse(localStorage.getItem(LABEL_KEY) || 'null');
      if (lp && lp.paper) $('labelPaper').value = lp.paper;
      if (lp && lp.size) $('labelSize').value = lp.size;
    } catch (e) { /* first visit or no storage */ }

    $('refreshBtn').addEventListener('click', function () { refreshQuiet(true); });

    // Pull to refresh on touch screens: pull down from the top of a page, release past 80px.
    var ptr = { y: 0, on: false, d: 0 };
    document.addEventListener('touchstart', function (e) {
      if (window.scrollY > 0 || $('appView').classList.contains('hidden') || $('dlg').open || cameraOn) { ptr.on = false; return; }
      ptr.y = e.touches[0].clientY; ptr.on = true; ptr.d = 0;
    }, { passive: true });
    document.addEventListener('touchmove', function (e) {
      if (!ptr.on) return;
      ptr.d = e.touches[0].clientY - ptr.y;
      if (ptr.d > 16) { $('ptr').classList.add('show'); $('ptrText').textContent = ptr.d > 80 ? 'Lepas untuk memperbarui' : 'Tarik untuk memperbarui'; }
      else $('ptr').classList.remove('show');
    }, { passive: true });
    document.addEventListener('touchend', function () {
      if (!ptr.on) return;
      ptr.on = false;
      if (ptr.d > 80) { $('ptrText').textContent = 'Memperbarui...'; refreshQuiet(true).then(function () { $('ptr').classList.remove('show'); }); }
      else $('ptr').classList.remove('show');
    });

    document.addEventListener('visibilitychange', function () {
      if (document.hidden) { stopCamera(true); stopLookup(); return; }
      if (page === 'scan' && cameraWanted() && !cameraOn && !$('dlg').open) startCamera();
      // Coming back to this tab (e.g. after saving on a phone): re-read the sheet, at most once a minute,
      // and pick up the shared cart straight away.
      if (session && state.me && Date.now() - lastRefresh > 60000) refreshQuiet();
      pollCart();
    });
    setInterval(syncTick, 1000);
  }

  // Exposed for the headless smoke test and for debugging from the console.
  window.inventoryApp = { handleCode: handleCode, setFlow: setFlow, showPage: showPage, saveFlow: saveFlow, carts: carts, state: function () { return state; }, sync: sync, pollCart: pollCart, flushOps: flushOps };

  init();
})();
