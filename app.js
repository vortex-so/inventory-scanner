/* Inventory Scanner front end. Plain JS, no build step.
   Talks to apps-script/Code.gs with JSON POSTs. See README.md. */
(function () {
  'use strict';

  var cfg = window.APP_CONFIG || {};
  var SESSION_KEY = 'inventory-scanner.session';
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };

  var FLOWS = {
    check: { action: 'INSPEKSI', title: 'Keranjang Pengecekan Kondisi', unit: 'unit' },
    out: { action: 'KELUAR', title: 'Keranjang Barang Keluar', unit: 'unit' },
    in: { action: 'MASUK', title: 'Keranjang Barang Masuk/Kembali', unit: 'unit' },
    group: { action: null, title: 'Keranjang Pengelompokan', unit: 'aset' }
  };
  var PAGE_TITLES = { home: 'Beranda', scan: 'Scan', inventory: 'Data Inventaris', containers: 'Kabinet & Box', history: 'Riwayat', labels: 'Cetak QR' };
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
  var carts = { check: [], out: [], in: [], group: [] };
  var pendingBatch = {};
  var flow = 'check';
  var groupTarget = '';
  var page = 'home';
  var scanner = null, cameraOn = false, lastCode = '', lastAt = 0;
  var labelSelected = {};
  var inventoryShown = 150;

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
  }
  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'b-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }
  function today() { return new Date().toLocaleDateString('en-CA'); }
  function show(viewId) {
    ['setupView', 'loginView', 'appView'].forEach(function (id) { $(id).classList.toggle('hidden', id !== viewId); });
    document.body.classList.toggle('has-nav', viewId === 'appView');
  }

  function openDialog(html) {
    var d = $('dlg');
    d.innerHTML = '<div class="box">' + html + '</div>';
    if (typeof d.showModal === 'function') d.showModal(); else d.setAttribute('open', '');
    return d;
  }
  function closeDialog() { var d = $('dlg'); if (d.open) d.close(); d.innerHTML = ''; }
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
    return fetch(cfg.apiUrl, { method: 'POST', body: body, redirect: 'follow' })
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

  function applySnapshot(d) {
    if (!d) return;
    if (d.items) state.items = d.items;
    if (d.containers) state.containers = d.containers;
    if (d.stats) state.stats = d.stats;
    if (d.transactions) state.transactions = d.transactions;
    if (d.types && d.types.length) state.types = d.types;
    if (d.me) state.me = d.me;
    renderAll();
  }

  // ---------- login ----------

  function init() {
    if (!cfg.apiUrl) { show('setupView'); return; }
    $('loginTitle').textContent = cfg.appName || 'Inventory Scanner';
    document.title = cfg.appName || 'Inventory Scanner';
    try { session = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); } catch (e) { session = null; }
    bindEvents();
    if (session && session.user && session.code) bootstrap();
    else show('loginView');
  }

  function bootstrap() {
    return api('bootstrap', {}, { loadingText: 'Memuat inventaris...' }).then(function (d) {
      try { localStorage.setItem(SESSION_KEY, JSON.stringify(session)); } catch (e) { /* private mode */ }
      applySnapshot(d);
      $('whoName').textContent = state.me.name;
      $('whoRole').textContent = state.me.role === 'admin' ? 'admin' : 'operator';
      document.body.classList.toggle('is-admin', state.me.role === 'admin');
      $('importPanel').classList.toggle('hidden', state.me.role !== 'admin');
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
    try { localStorage.removeItem(SESSION_KEY); } catch (e) { /* ignore */ }
    $('loginError').classList.add('hidden');
    $('loginCode').value = '';
    show('loginView');
  }

  // ---------- navigation ----------

  function showPage(name) {
    if (!$('page-' + name)) name = 'home';
    if (page === 'scan' && name !== 'scan') stopCamera();
    page = name;
    document.querySelectorAll('.page').forEach(function (p) { p.classList.toggle('active', p.id === 'page-' + name); });
    document.querySelectorAll('#nav button').forEach(function (b) { b.classList.toggle('active', b.dataset.page === name); });
    $('pageTitle').textContent = PAGE_TITLES[name] || name;
    window.scrollTo(0, 0);
  }

  function setFlow(name) {
    if (!FLOWS[name]) return;
    flow = name;
    document.querySelectorAll('#flowTabs button').forEach(function (b) { b.classList.toggle('active', b.dataset.flow === name); });
    ['check', 'out', 'in', 'group'].forEach(function (f) { $('form-' + f).classList.toggle('hidden', f !== name); });
    $('groupTargetWrap').classList.toggle('hidden', name !== 'group');
    $('groupPick').classList.toggle('hidden', name !== 'group');
    $('saveBtn').textContent = name === 'group' ? 'Simpan ke wadah' : 'Simpan ' + (name === 'check' ? 'hasil pengecekan' : name === 'out' ? 'barang keluar' : 'barang masuk');
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

  function startCamera() {
    if (cameraOn) return;
    if (!window.Html5Qrcode) { scanStatus('Pustaka kamera tidak termuat. Muat ulang halaman.', 'err'); return; }
    scanStatus('Membuka kamera...');
    try {
      if (!scanner) {
        var formats = window.Html5QrcodeSupportedFormats ? [Html5QrcodeSupportedFormats.QR_CODE] : undefined;
        scanner = new Html5Qrcode('reader', { verbose: false, formatsToSupport: formats, experimentalFeatures: { useBarCodeDetectorIfSupported: true } });
      }
      scanner.start(
        { facingMode: 'environment' },
        { fps: 10, aspectRatio: 1, qrbox: function (w, h) { var s = Math.floor(Math.min(w, h) * 0.75); return { width: s, height: s }; } },
        onDecoded,
        function () { /* no code in frame */ }
      ).then(function () {
        cameraOn = true;
        $('camStart').disabled = true;
        scanStatus('Kamera aktif. Arahkan ke QR.', '');
      }).catch(cameraFailed);
    } catch (err) { cameraFailed(err); }
  }
  function cameraFailed(err) {
    cameraOn = false;
    var msg = (err && err.message) || String(err || '');
    scanStatus('Kamera tidak bisa dibuka: ' + msg + '. Izinkan kamera untuk situs ini, pastikan alamat https, dan buka di Chrome/Safari, bukan di browser WhatsApp.', 'err');
  }
  function stopCamera() {
    $('camStart').disabled = false;
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

  function handleCode(raw) {
    var code = String(raw || '').trim();
    if (!code) return Promise.resolve(false);
    var hit = findLocal(code);
    if (hit.item || hit.container) return Promise.resolve(addHit(hit, code));
    return api('lookup', { code: code }, { silent: true }).then(function (d) {
      if (d.item && !state.items.some(function (x) { return x.id === d.item.id; })) state.items.push(d.item);
      if (d.container && !state.containers.some(function (c) { return c.cabinetId === d.container.cabinetId; })) state.containers.push(d.container);
      return addHit({ item: d.item, container: d.container, members: d.members || [] }, code);
    }).catch(function (e) {
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
        groupTarget = hit.container.cabinetId;
        $('groupTarget').value = groupTarget;
        scanStatus('Tujuan: ' + hit.container.cabinetId + ' (' + hit.container.name + '). Sekarang scan isinya.', 'ok');
        buzz(true); renderGroupPick(); return true;
      }
      if (!groupTarget) { scanStatus('Pilih atau scan kabinet/box tujuan dulu.', 'err'); buzz(false); return false; }
      return pushCart(hit.item, 'group', '') ? (scanStatus('Masuk keranjang: ' + hit.item.id, 'ok'), buzz(true), true) : (scanStatus('Sudah ada di keranjang: ' + hit.item.id, 'err'), buzz(false), false);
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

  function pushCart(item, f, cabinetId) {
    if (!item) return false;
    var cart = carts[f];
    for (var i = 0; i < cart.length; i++) if (cart[i].id === item.id) { if (cabinetId) cart[i]._cartCabinetId = cabinetId; return false; }
    var copy = {}; for (var k in item) copy[k] = item[k];
    copy._cartCabinetId = cabinetId || '';
    cart.push(copy);
    renderCart();
    return true;
  }
  function removeFromCart(f, id) {
    carts[f] = carts[f].filter(function (x) { return x.id !== id; });
    renderCart();
  }

  function renderCart() {
    Object.keys(FLOWS).forEach(function (f) { $('count-' + f).textContent = carts[f].length + ' ' + FLOWS[f].unit; });
    var cart = carts[flow];
    $('cartTitle').textContent = FLOWS[flow].title + ' · ' + cart.length;
    if (!cart.length) { $('cartList').innerHTML = '<div class="empty">Belum ada barang. Scan QR, ketik ID, atau pilih dari daftar inventaris.</div>'; return; }
    $('cartList').innerHTML = cart.map(function (x) {
      var cab = x._cartCabinetId || x.cabinetId;
      return '<div class="item"><div class="info"><strong>' + esc(x.id) + '</strong><div class="meta">' + esc(x.name) + ' · ' + esc(typeLabel(x.type)) +
        ' ' + pillStatus(x.locationStatus) + (cab ? ' <span class="pill">' + esc(cab) + '</span>' : '') + '</div></div>' +
        '<div class="ops"><button class="btn secondary small" type="button" data-remove="' + esc(x.id) + '">Hapus</button></div></div>';
    }).join('');
  }

  function saveFlow() {
    var cart = carts[flow];
    if (!cart.length) { toast('Keranjang kosong. Scan atau pilih barang dulu.', true); return; }
    if (flow === 'group') return saveGroup('assign');
    var payload = { action: FLOWS[flow].action, ids: cart.map(function (x) { return x.id; }), note: $('note-' + flow).value.trim() };
    payload.cabinetIds = cart.map(function (x) { return x._cartCabinetId; }).filter(function (v, i, a) { return v && a.indexOf(v) === i; });
    if (flow === 'check') {
      payload.condition = $('condition').value;
      payload.damageNote = $('damageNote').value.trim();
      if (payload.condition === 'RUSAK' && !payload.damageNote) { toast('Keterangan kerusakan wajib diisi.', true); $('damageNote').focus(); return; }
    } else {
      payload.eventDate = $('date-' + flow).value;
      payload.location = $('location-' + flow).value.trim();
      payload.eventName = $('event-' + flow).value.trim();
      if (flow === 'in') payload.storeLocation = $('store-in').value.trim();
      if (!payload.eventDate) { toast('Tanggal wajib diisi.', true); $('date-' + flow).focus(); return; }
      if (!payload.location) { toast('Lokasi wajib diisi.', true); $('location-' + flow).focus(); return; }
    }
    var what = flow === 'check' ? 'hasil pengecekan ' + payload.condition : (flow === 'out' ? 'barang keluar ke ' + payload.location : 'barang masuk dari ' + payload.location);
    confirmDialog('Simpan ' + cart.length + ' unit?', 'Simpan ' + what + ' untuk ' + cart.length + ' unit.', 'Simpan').then(function (yes) {
      if (!yes) return;
      pendingBatch[flow] = pendingBatch[flow] || uuid();
      api('commit', payload, { batchId: pendingBatch[flow], loadingText: 'Menyimpan ' + cart.length + ' unit...' }).then(function (d) {
        delete pendingBatch[flow];
        carts[flow] = [];
        resetForm(flow);
        applySnapshot(d);
        toast(d.message || 'Tersimpan.');
        scanStatus('Tersimpan. Siap scan berikutnya.', 'ok');
      }).catch(function (e) {
        if (e.invalid && e.invalid.length) {
          var bad = {}; e.invalid.forEach(function (id) { bad[id.toLowerCase()] = true; });
          carts[flow] = carts[flow].filter(function (x) { return !bad[x.id.toLowerCase()]; });
          renderCart();
          toast(e.message + ' Barang itu dikeluarkan dari keranjang; tekan Simpan lagi.', true);
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
      if (!yes) return;
      var key = 'group-' + mode;
      pendingBatch[key] = pendingBatch[key] || uuid();
      var call = mode === 'assign' ? api('container.assign', { cabinetId: groupTarget, ids: ids }, { batchId: pendingBatch[key], loadingText: 'Menyimpan...' })
        : api('container.unassign', { ids: ids }, { batchId: pendingBatch[key], loadingText: 'Menyimpan...' });
      call.then(function (d) {
        delete pendingBatch[key];
        carts.group = [];
        applySnapshot(d);
        toast(d.message || 'Tersimpan.');
      }).catch(function (e) {
        if (e.invalid && e.invalid.length) {
          var bad = {}; e.invalid.forEach(function (id) { bad[id.toLowerCase()] = true; });
          carts.group = carts.group.filter(function (x) { return !bad[x.id.toLowerCase()]; });
          renderCart();
        }
        toast(e.message, true);
      });
    });
  }

  function resetForm(f) {
    $('note-' + f).value = '';
    if (f === 'check') { $('damageNote').value = ''; }
    else { $('location-' + f).value = ''; $('event-' + f).value = ''; $('date-' + f).value = today(); if (f === 'in') $('store-in').value = 'Gudang'; }
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
    var list = groupPickMatches();
    var shown = list.slice(0, 60);
    $('groupPickList').innerHTML = shown.length ? shown.map(function (x) {
      return '<div class="item"><div class="info"><strong>' + esc(x.id) + '</strong><div class="meta">' + esc(x.name) + ' · ' + esc(typeLabel(x.type)) +
        (x.cabinetId ? ' <span class="pill">' + esc(x.cabinetId) + '</span>' : ' <span class="muted">belum ada wadah</span>') + '</div></div>' +
        '<div class="ops"><button class="btn secondary small" type="button" data-pick="' + esc(x.id) + '">+ Tambah</button></div></div>';
    }).join('') + (list.length > shown.length ? '<div class="small muted" style="padding:8px 0">Menampilkan ' + shown.length + ' dari ' + list.length + '. Persempit pencarian.</div>' : '')
      : '<div class="empty">Tidak ada aset yang cocok.</div>';
  }

  // ---------- rendering ----------

  function pillCondition(c) {
    if (c === 'BAIK') return '<span class="pill good">BAIK</span>';
    if (c === 'RUSAK') return '<span class="pill bad">RUSAK</span>';
    return '<span class="pill">BELUM DICEK</span>';
  }
  function pillStatus(s) { return s === 'DI LUAR' ? '<span class="pill out">DI LUAR</span>' : '<span class="pill good">DI GUDANG</span>'; }

  function renderAll() {
    renderHome();
    renderInventory();
    renderContainers();
    renderGroupTarget();
    renderHistory();
    renderLabels();
    renderCart();
    renderGroupPick();
    fillTypeSelect();
  }

  function renderHome() {
    var s = state.stats || {};
    var cards = [['Total unit aktif', s.total], ['Kondisi baik', s.good], ['Kondisi rusak', s.damaged], ['Belum dicek', s.unchecked],
      ['Sedang di luar', s.out], ['Tersedia di gudang', s.inWarehouse], ['Kabinet / Box', s.boxes]];
    $('statCards').innerHTML = cards.map(function (c) {
      return '<div class="card"><div class="label">' + c[0] + '</div><div class="num">' + Number(c[1] || 0).toLocaleString('id-ID') + '</div></div>';
    }).join('');
    $('homeRecent').innerHTML = state.transactions.length ? txnTable(state.transactions.slice(0, 8)) : '<div class="empty">Belum ada transaksi.</div>';
  }

  function txnTable(rows) {
    return '<table><thead><tr><th>Waktu</th><th>Tindakan</th><th>ID / Barang</th><th>Tanggal</th><th>Lokasi</th><th>Acara</th><th>Wadah</th><th>Oleh</th><th>Catatan</th></tr></thead><tbody>' +
      rows.map(function (t) {
        var extra = t.action === 'INSPEKSI' ? ' ' + pillCondition(t.condition) + (t.damage_note ? '<br><small>' + esc(t.damage_note) + '</small>' : '') : '';
        return '<tr><td>' + esc(t.ts) + '</td><td>' + esc(t.action) + extra + '</td><td><strong>' + esc(t.item_id) + '</strong><br>' + esc(t.item_name) + '</td><td>' + esc(t.event_date) +
          '</td><td>' + esc(t.location) + '</td><td>' + esc(t.event_name) + '</td><td>' + esc(t.cabinet_id || '-') + '</td><td>' + esc(t.user) + '</td><td>' + esc(t.note) + '</td></tr>';
      }).join('') + '</tbody></table>';
  }

  function inventoryMatches() {
    var q = $('inventorySearch').value.trim().toLowerCase();
    var f = $('inventoryFilter').value;
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
    var shown = list.slice(0, inventoryShown);
    var admin = state.me && state.me.role === 'admin';
    $('inventoryCount').textContent = list.length + ' dari ' + state.items.length + ' unit aktif';
    $('inventoryMore').classList.toggle('hidden', list.length <= shown.length);
    if (!shown.length) { $('inventoryList').innerHTML = '<div class="empty">Tidak ada barang yang cocok.</div>'; return; }
    $('inventoryList').innerHTML = shown.map(function (x) {
      return '<div class="item"><div class="info"><strong>' + esc(x.id) + '</strong><div>' + esc(x.name) + ' <span class="muted">· ' + esc(typeLabel(x.type)) + (x.category ? ' · ' + esc(x.category) : '') + '</span></div>' +
        '<div class="meta">' + pillCondition(x.condition) + pillStatus(x.locationStatus) + '<span>' + esc(x.location) + '</span>' +
        (x.cabinetId ? '<span class="pill info">' + esc(x.cabinetId) + '</span>' : '') + (x.damageNote ? '<span class="muted">' + esc(x.damageNote) + '</span>' : '') + '</div></div>' +
        '<div class="ops"><div class="row" style="gap:4px"><button class="btn secondary small" type="button" data-cart="check" data-id="' + esc(x.id) + '">Cek</button>' +
        '<button class="btn secondary small" type="button" data-cart="out" data-id="' + esc(x.id) + '">OUT</button><button class="btn secondary small" type="button" data-cart="in" data-id="' + esc(x.id) + '">IN</button></div>' +
        '<div class="row" style="gap:4px"><button class="btn secondary small" type="button" data-history="' + esc(x.id) + '">Riwayat</button>' +
        (admin ? '<button class="btn secondary small" type="button" data-edit="' + esc(x.id) + '">Edit</button><button class="btn danger small" type="button" data-deactivate="' + esc(x.id) + '">Hapus</button>' : '') +
        '</div></div></div>';
    }).join('');
  }

  function fillTypeSelect() {
    var sel = $('importType');
    var current = sel.value;
    sel.innerHTML = state.types.map(function (t) { return '<option value="' + esc(t) + '">' + esc(typeLabel(t)) + '</option>'; }).join('');
    if (current) sel.value = current;
  }

  function renderContainers() {
    var list = state.containers;
    if (!list.length) { $('containerList').innerHTML = '<div class="empty">Belum ada kabinet/box. Tambah wadah dulu, lalu kelompokkan asetnya lewat Scan › Kelompok.</div>'; return; }
    $('containerList').innerHTML = list.map(function (c) {
      var disabled = c.itemCount ? '' : ' disabled';
      return '<div class="item"><div class="info"><strong>' + esc(c.cabinetId) + ' <span class="pill">' + (c.containerType === 'BOX' ? 'Box' : 'Kabinet') + '</span></strong>' +
        '<div>' + esc(c.name) + (c.category ? ' <span class="muted">· ' + esc(c.category) + '</span>' : '') + '</div>' +
        '<div class="meta"><span>' + c.itemCount + ' aset</span>' + (c.damagedCount ? '<span class="pill bad">' + c.damagedCount + ' rusak</span>' : '') +
        (c.outCount ? '<span class="pill out">' + c.outCount + ' di luar</span>' : '') + (c.note ? '<span class="muted">' + esc(c.note) + '</span>' : '') + '</div></div>' +
        '<div class="ops"><div class="row" style="gap:4px"><button class="btn secondary small" type="button" data-ccart="check" data-cid="' + esc(c.cabinetId) + '"' + disabled + '>Cek</button>' +
        '<button class="btn secondary small" type="button" data-ccart="out" data-cid="' + esc(c.cabinetId) + '"' + disabled + '>OUT</button><button class="btn secondary small" type="button" data-ccart="in" data-cid="' + esc(c.cabinetId) + '"' + disabled + '>IN</button></div>' +
        '<div class="row" style="gap:4px"><button class="btn secondary small" type="button" data-group="' + esc(c.cabinetId) + '">Isi</button><button class="btn secondary small" type="button" data-cedit="' + esc(c.cabinetId) + '">Edit</button></div></div></div>';
    }).join('');
  }

  function renderHistory() {
    var q = $('historySearch').value.trim().toLowerCase();
    var a = $('historyAction').value;
    var rows = state.transactions.filter(function (t) {
      if (a && t.action !== a) return false;
      if (!q) return true;
      return [t.item_id, t.item_name, t.event_name, t.location, t.user, t.cabinet_id, t.note, t.batch_id].join(' ').toLowerCase().indexOf(q) >= 0;
    });
    $('historyCount').textContent = rows.length + ' dari ' + state.transactions.length + ' transaksi terakhir yang dimuat. Riwayat lengkap ada di sheet.';
    $('historyTable').innerHTML = rows.length ? txnTable(rows) : '<div class="empty">Belum ada riwayat.</div>';
  }

  function showHistory(id) {
    api('history', { itemId: id }, { loadingText: 'Memuat riwayat ' + id }).then(function (d) {
      var rows = d.transactions || [];
      openDialog('<h2>Riwayat ' + esc(id) + '</h2>' + (rows.length ? '<div class="tablewrap" style="max-height:60vh">' + txnTable(rows) + '</div>' : '<div class="empty">Belum ada riwayat.</div>') +
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

  // ---------- labels ----------

  function labelMatches() {
    var q = $('labelSearch').value.trim().toLowerCase();
    return state.items.filter(function (x) { return !q || [x.id, x.name, x.category, x.type].join(' ').toLowerCase().indexOf(q) >= 0; });
  }
  function renderLabels() {
    var list = labelMatches();
    var n = Object.keys(labelSelected).length;
    $('labelCount').textContent = n + ' dipilih · ' + list.length + ' hasil';
    var shown = list.slice(0, 300);
    $('labelList').innerHTML = shown.length ? shown.map(function (x) {
      return '<label class="item" style="margin:0;font-weight:400;font-size:14px;color:inherit;cursor:pointer"><input type="checkbox" data-label="' + esc(x.id) + '"' + (labelSelected[x.id] ? ' checked' : '') + '>' +
        '<div class="info"><strong>' + esc(x.id) + '</strong><div class="meta">' + esc(x.name) + ' · ' + esc(typeLabel(x.type)) + '</div></div></label>';
    }).join('') + (list.length > shown.length ? '<div class="small muted" style="padding:8px 0">Menampilkan 300 dari ' + list.length + '. Persempit pencarian.</div>' : '') : '<div class="empty">Tidak ada barang.</div>';
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
    area.className = 'qrgrid size-' + $('labelSize').value;
    area.innerHTML = items.map(function (x) {
      return '<div class="qrcard">' + qrSvg(x.qrValue || x.id) + '<strong>' + esc(x.id) + '</strong><small>' + esc(x.name) + ' · ' + esc(typeLabel(x.type)) + '</small></div>';
    }).join('');
    $('toast').className = 'toast';
    setTimeout(function () { window.print(); }, 150);
  }

  // ---------- import and containers forms ----------

  function submitImport(e) {
    e.preventDefault();
    var form = e.target;
    var f = {};
    new FormData(form).forEach(function (v, k) { f[k] = String(v); });
    var ids = f.ids.split(/[\n\r\t,;]+/).map(function (s) { return s.trim(); }).filter(Boolean);
    if (!ids.length) { toast('Tempelkan minimal satu ID.', true); return; }
    if (ids.length > 2000) { toast('Maksimal 2.000 ID per proses.', true); return; }
    confirmDialog('Tambah ' + ids.length + ' ID?', 'ID yang sudah ada akan dilewati.', 'Tambah').then(function (yes) {
      if (!yes) return;
      f.ids = ids;
      api('item.import', f, { batchId: uuid(), loadingText: 'Mendaftarkan ' + ids.length + ' ID...' }).then(function (d) {
        applySnapshot(d);
        form.elements.ids.value = '';
        toast(d.message);
        if (d.skippedCount) console.info('ID duplikat yang dilewati:', d.skipped);
      }).catch(function (err) { toast(err.message, true); });
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
      session = { user: $('loginUser').value.trim(), code: $('loginCode').value.trim() };
      $('loginError').classList.add('hidden');
      bootstrap();
    });
    $('menuBtn').addEventListener('click', function () {
      var d = openDialog('<h2>' + esc(state.me ? state.me.name : '') + '</h2><p class="muted small">' + esc(cfg.appName || 'Inventory Scanner') + ' · ' + esc(location.host) + '</p>' +
        '<div class="actions" style="flex-direction:column"><button class="btn secondary" type="button" data-m="reload">Muat ulang data</button>' +
        '<button class="btn secondary" type="button" data-m="labels">Cetak label QR</button>' +
        '<button class="btn secondary" type="button" data-m="logout">Keluar</button><button class="btn" type="button" data-m="close">Tutup</button></div>');
      d.querySelectorAll('[data-m]').forEach(function (b) {
        b.addEventListener('click', function () {
          closeDialog();
          if (b.dataset.m === 'reload') bootstrap();
          if (b.dataset.m === 'labels') showPage('labels');
          if (b.dataset.m === 'logout') logout();
        });
      });
    });
    document.querySelectorAll('#nav button').forEach(function (b) { b.addEventListener('click', function () { showPage(b.dataset.page); }); });
    document.querySelectorAll('[data-go]').forEach(function (b) {
      b.addEventListener('click', function () { if (b.dataset.flow) setFlow(b.dataset.flow); showPage(b.dataset.go); });
    });
    document.querySelectorAll('#flowTabs button').forEach(function (b) { b.addEventListener('click', function () { setFlow(b.dataset.flow); }); });

    $('camStart').addEventListener('click', startCamera);
    $('camStop').addEventListener('click', stopCamera);
    $('scanAdd').addEventListener('click', function () { var v = $('scanInput').value; $('scanInput').value = ''; handleCode(v); $('scanInput').focus(); });
    $('scanInput').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); $('scanAdd').click(); } });
    $('cartClear').addEventListener('click', function () { carts[flow] = []; if (flow === 'group') { groupTarget = ''; $('groupTarget').value = ''; } renderCart(); renderGroupPick(); });
    $('cartList').addEventListener('click', function (e) { var b = e.target.closest('[data-remove]'); if (b) { removeFromCart(flow, b.dataset.remove); if (flow === 'group') renderGroupPick(); } });
    $('saveBtn').addEventListener('click', saveFlow);
    $('groupUnassign').addEventListener('click', function () { saveGroup('unassign'); });
    $('condition').addEventListener('change', function () { $('damageWrap').classList.toggle('hidden', $('condition').value !== 'RUSAK'); });
    $('groupTarget').addEventListener('change', function () {
      var next = $('groupTarget').value;
      if (carts.group.length && groupTarget && next !== groupTarget) {
        confirmDialog('Ganti tujuan?', 'Keranjang berisi aset untuk ' + groupTarget + '. Kosongkan keranjang untuk ganti ke ' + (next || 'tujuan lain') + '?', 'Kosongkan', true).then(function (yes) {
          if (yes) { carts.group = []; groupTarget = next; renderCart(); renderGroupPick(); } else $('groupTarget').value = groupTarget;
        });
        return;
      }
      groupTarget = next;
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

    $('inventorySearch').addEventListener('input', function () { inventoryShown = 150; renderInventory(); });
    $('inventoryFilter').addEventListener('change', function () { inventoryShown = 150; renderInventory(); });
    $('inventoryMore').addEventListener('click', function () { inventoryShown += 150; renderInventory(); });
    $('inventoryList').addEventListener('click', function (e) {
      var b = e.target.closest('button'); if (!b) return;
      if (b.dataset.cart) {
        var x = state.items.filter(function (i) { return i.id === b.dataset.id; })[0];
        if (!x) return;
        setFlow(b.dataset.cart);
        var added = pushCart(x, b.dataset.cart, '');
        showPage('scan');
        toast(added ? x.id + ' masuk keranjang.' : x.id + ' sudah ada di keranjang.', !added);
      }
      if (b.dataset.history) showHistory(b.dataset.history);
      if (b.dataset.edit) editItem(b.dataset.edit);
      if (b.dataset.deactivate) deactivateItem(b.dataset.deactivate);
    });
    $('importToggle').addEventListener('click', function () {
      var f = $('importForm'); f.classList.toggle('hidden');
      $('importToggle').textContent = f.classList.contains('hidden') ? 'Buka' : 'Tutup';
    });
    $('importForm').addEventListener('submit', submitImport);

    $('containerFormToggle').addEventListener('click', function () { $('containerForm').classList.toggle('hidden'); previewContainerId(); });
    $('containerFormCancel').addEventListener('click', function () { $('containerForm').reset(); $('containerForm').classList.add('hidden'); });
    $('containerType').addEventListener('change', previewContainerId);
    $('containerForm').addEventListener('submit', submitContainer);
    $('containerList').addEventListener('click', function (e) {
      var b = e.target.closest('button'); if (!b) return;
      if (b.dataset.ccart) addContainerToCart(b.dataset.cid, b.dataset.ccart);
      if (b.dataset.group) { groupTarget = b.dataset.group; carts.group = []; goScan('group'); $('groupTarget').value = groupTarget; renderGroupPick(); }
      if (b.dataset.cedit) editContainer(b.dataset.cedit);
    });

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

    document.addEventListener('visibilitychange', function () { if (document.hidden) stopCamera(); });
    ['out', 'in'].forEach(function (f) { $('date-' + f).value = today(); });
  }

  // Exposed for the headless smoke test and for debugging from the console.
  window.inventoryApp = { handleCode: handleCode, setFlow: setFlow, showPage: showPage, saveFlow: saveFlow, carts: carts, state: function () { return state; } };

  init();
})();
