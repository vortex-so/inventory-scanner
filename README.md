# Inventory Scanner

Phones scan the QR labels on equipment to check it out, check it back in, record its condition and group
it into storage (pouches, bags, cases, containers). Every scan lands in a Google Sheet. The data model is
the Vortex Media team's own format for its camera, lens and lighting gear ("Format Inventaris Alat Media",
Bagas, 26 Okt 2026); the categories live in the sheet, so another unit can use its own.

**Status:** pilot, not yet deployed · **Default branch:** `main` · **Source of truth:** github.com/vortex-so/inventory-scanner · **Build/release:** none; GitHub Pages serves `main`, and the backend is pasted into Apps Script

It replaces an earlier Apps Script prototype whose camera lived on a second browser tab. Here the camera,
the cart and the Save button are on one page, so a scan cannot get lost, and a USB scanner or typed ID
goes into the same field.

**Parts, and that is all of them**

| Part | What | Where |
|---|---|---|
| Front end | `index.html`, `app.js`, `app.css`, `config.js`, manifest, icons and the Vortex logo | any static host, this repo's Pages |
| Backend | `apps-script/Code.gs` | pasted into the Apps Script bound to the sheet |
| Store | one Google Sheet with tabs `Items`, `Storage`, `Transactions`, `Users`, `Carts`, `Lists` | a company Google account |
| Libraries | `vendor/` (QR scanning, QR drawing, the Rethink Sans font), pinned, self-hosted | see `vendor/README.md` |

No build step, no CI, no service worker, no npm. Deploy is a push. The sheet is the database, the admin
panel and the backup (File › Version history).

## One-time setup

1. **Sheet.** In the company Google account create a blank Google Sheet, name it e.g. `Inventaris Alat Media`.
2. **Script.** In the sheet: Extensions › Apps Script. Replace the contents of `Code.gs` with
   `apps-script/Code.gs` from this repo. Project Settings › tick "Show appsscript.json", replace it with
   `apps-script/appsscript.json`. Save.
3. **Tabs and admin.** In the editor pick the function `setup` and Run. Approve the permissions (it only
   touches this sheet). Open Executions or the log: it prints `name=admin code=NNNNNN`. The `Users` tab now
   holds that admin row. Add one row per person: `name`, `code`, `role` (`admin` or `operator`), `active` = `TRUE`.
   Operators can scan, save and group; admins can also import, edit and deactivate items.
4. **Deploy.** Deploy › New deployment › type Web app › Execute as **Me** · Who has access **Anyone** ›
   Deploy. Copy the URL ending in `/exec`.
5. **Front end.** Put the URL into `config.js` as a unit: `{ key: 'media', name: 'Vortex Media', apiUrl: '…/exec' }`.
   One unit means no selector on the login screen; a second sheet and script for another unit (KPTJ, Media's
   camera gear) is one more line, and the login screen then asks which unit. Commit and push. Enable Pages on the repo
   (GitHub: Settings › Pages › Deploy from branch `main`, folder `/`). Open the Pages URL on a phone,
   log in with name and code, tap Add to Home Screen.
6. **Lists.** setup() fills the `Lists` tab with the media team's categories, sub-categories, storage
   places (Storage, Drybox) and storage types (Pouch, Tas, Koper, Kontainer), each with its short code.
   Edit, add or remove rows there; the app reads them at the next login.
7. **Items.** Admin › Data Inventory › Tambah Aset, one form per item (see "Item codes" below).

After any change to `Code.gs`: paste the new file, run `setup` once (it adds new columns to tabs that are
still empty and never rewrites a tab that holds data), then Deploy › Manage deployments › edit › New
version. The URL stays the same.

## Everyday use

- **Scan.** Pick the flow at the top (Pengecekan Kondisi · Barang Keluar · Barang Masuk/Kembali ·
  Kelompokkan), start the camera, point at labels. Each read shows a card over the camera with the ID in
  large type and its place in the cart ("ke-5 di keranjang"), the corners flash and a count in the corner
  ticks up, so two similar IDs in a row are still clearly two scans. Green = added, amber = already in the
  cart, red = not found or refused, each with its own sound (iPhones do not vibrate for websites). Holding
  the camera on the same label stays silent; it lands at the top of the cart with a short green flash. Typing an ID or a USB scanner's keystrokes into the field under the
  camera does the same. Once the camera has been started it starts by itself the next time the Scan
  screen opens; Hentikan switches that off.
- **Hold it about 20 cm away.** The camera runs at up to 1920 x 1080 and the centre square (the red corners)
  is decoded at the camera's own resolution, so a 20 mm label reads from roughly 15 to 35 cm, where phone
  cameras are in focus. The scanning library's own loop decoded a ~240 px copy and needed the label within
  about 6-12 cm, closer than iPhones focus; only its decoder is used now (the browser's built-in detector
  where there is one, ZXing in thorough mode on iPhones). Measured with a fake camera: `node test/smoke.mjs`
  checks that a label at 15 % of the frame width is read.
- **Save.** Simpan opens one sheet with Bagas's forms. Date and person in charge are filled in (today, the
  login). Barang Keluar asks for the destination or event; Barang Masuk shows where the items came from
  and asks where they go (Storage, Drybox); Pengecekan Kondisi asks for the result (Good, Need
  Maintenance, Broken, Untested) and the status (Active, Passive). The sheet remembers what you typed if a
  save is refused, so a retry is one tap.
- **Item codes.** Tambah Aset makes the code from category code, sub-category code, the first 3 letters of
  the brand and the last 4 characters of the serial number: Kamera / SONY Camera / Sony / SN ...4567 is
  `KM-SON-SON-4567`. Without a serial number each unit gets a running number (`CS-CBL-UGR-001`, `-002`, ...),
  so "Jumlah 6" registers six cables at once. The form shows the code before saving; a code that exists
  gets `-2`; a removed code is never reused. For labels already printed, tick "Label sudah tercetak" and
  paste the IDs. After saving, the new codes are ticked in Cetak QR.
- **Storage.** A pouch, bag, case or container gets an ID (`POU-001`, `KOP-001`, ...) or the label already
  on it. Scanning that label puts its whole contents in the cart; in the Kelompokkan flow, scan the storage
  first and then the items going into it.
- **Rules the server enforces.** Out only when not On Duty and not Passive, in only when On Duty and into a
  listed place, a check needs a result and a status, Broken and Need Maintenance need a note, unknown IDs
  are refused. A refused save names the offending IDs and the app removes them from the cart so you can
  save the rest.
- **Retries are safe.** Every save carries a batch id; a repeat after a timeout is not written twice.
- **One cart per login, on every device.** The cart lives in the sheet's `Carts` tab, one row per login.
  Your phone, your second phone and your laptop, logged in with the same name and code, show the same cart:
  a scan on one appears on the others within about 3 seconds (the Scan page asks every 3 s, other pages every
  15 s, never in a hidden tab). Devices send small changes ("add this ID", "remove", "clear"), never a whole
  cart, so two phones scanning in the same second both keep their scans. Simpan saves the IDs you saw and
  removes them from the cart for every device; a second Simpan of the same cart from another device finds
  nothing left and writes nothing. Different logins never share a cart, so give each crew member their own
  row in `Users`: two people on one login doing two different check-outs at once would fill one cart.
- **The cart survives.** Unsent changes and drafts are also kept in the device's local storage, so no
  signal, a closed browser or a dead battery loses nothing; they are sent when the app is back online.
- **The laptop follows.** When anything is saved elsewhere, an open laptop re-reads the sheet on its next
  check, so Dashboard and Riwayat show a phone's check-out within seconds.
- **Look.** The Vortex theme: dark surfaces, the red mark, gold section tags, Rethink Sans headings, taken
  from vortex.so. The logo files are `vortex-logo.png` (lockup, white wordmark) and `vortex-mark.png`.
- **Rows open a sheet.** Tap an item or a storage row and one sheet shows everything you can do with it;
  the likely action is the white button (Keluar for an item in storage, Masuk for one On Duty; a Passive
  item cannot go out).
- **Find by scanning.** The scan button beside the inventory search opens the camera; point at a label
  and its sheet opens. Typing the ID there works too.
- **Filters are chips.** Semua · Tersimpan · On Duty · Need Maintenance · Broken · Untested · Passive ·
  Tanpa wadah, one tap each. Search covers code, brand, type, serial number, storage and destination.
- **History is per save.** Dashboard and Riwayat show one row per save ("Keluar · 8 unit · Ke Wisuda UGM ·
  23:18 · admin") that expands to its rows. The per-item Riwayat lists that item's rows.
- **Long lists render as you scroll.** All items come down in one call (a few hundred rows is ~100 KB);
  the page draws 60 at a time and adds more as you scroll. Search and filters work on the whole set.
- **Refresh.** Pull down from the top of any page on a phone, tap the refresh icon in the top bar, or just
  come back to the tab: it re-reads the sheet when it regains focus (at most once a minute). The top bar
  shows when the data was last read.
- **Two layouts, one page.** On a laptop or tablet the app shows the sidebar of the original prototype
  (Dashboard · Action · Tools · Riwayat) and the two-column scan screen; on a phone a bottom bar. Same
  names, same forms.
- **Labels.** Cetak QR draws QR codes in the browser. *Printer label* (the default) prints one label per
  sticker for a Brother QL or similar: pick the loaded roll under Paper size in Chrome's print dialog (e.g.
  29 x 90 mm), scale 100 %; Layout Landscape puts the code left and the text right. *Kertas A4* prints a grid
  to cut out. QR sizes 15, 20, 25 mm, never larger than the label. Chrome's own header and footer are off.
  Checked by rendering 29 x 90, 90 x 29, 62 x 29, 17 x 54 mm and A4 and decoding every printed code.

## The sheet

| Tab | Columns |
|---|---|
| `Items` | id · qr_value · category · subcategory · brand · model · serial · location (a place from Lists, or `On Duty`) · destination (where its last check-out went) · status (`Active`/`Passive`) · condition (`Good`/`Need Maintenance`/`Broken`/`Untested`) · condition_note · note · storage_id · active · created_at · updated_at · last_checked_at · last_user |
| `Storage` | storage_id · storage_type · name · category · note · active · created_at · updated_at |
| `Transactions` | ts · batch_id · action · item_id · item_name · category · event_date · from · to · storage_id · condition · status · note · user |
| `Users` | name · code · role · active |
| `Carts` | user · rev · data (the login's open carts as JSON) · updated_at — created on first use; clear a row to empty that login's cart |
| `Lists` | list (`kategori`, `subkategori`, `lokasi`, `wadah`) · value · code · parent (a sub-category's category) |

Transactions is append-only and is the history: a check-out reads `from` Storage `to` the event, a check-in
`from` the event `to` Drybox. Items and Storage hold current state and may be fixed by hand in the sheet;
the app reads the sheet fresh on every call. `setup()` formats all cells as plain text so IDs and codes
come back exactly as typed. `active = FALSE` removes an item (Nonaktifkan); `Passive` keeps it in the
inventory but out of check-outs. No price, owner or depreciation columns: this app records where a thing
is, the asset register lives elsewhere.

**Moving an existing list in.** Paste rows straight into `Items` with the columns above (`active` = `TRUE`,
`location` a place from Lists, `condition` and `status` from the lists above), or register each item through
Tambah Aset so it gets a code. A sheet made by the earlier LED-screen version takes the new columns when
`setup` is run, as long as its tabs are still empty.

## See the backend work, before any company account exists

The dev server runs the real `Code.gs` in Node against an in-memory sheet and shows that sheet live:

```
node test/dev-server.mjs        # app on http://localhost:8787, the sheet tabs on http://localhost:8787/sheet
```

Save something in the app and watch the rows appear on `/sheet` (new rows are green). To try a real
Google Sheet with your own account: do setup steps 1 to 4 above in that account, then

```
TRIAL_API=https://script.google.com/macros/s/XXXX/exec node test/dev-server.mjs
```

The login screen now offers two units, "Lokal (memori)" and "Percobaan (Google Sheet)". Pick the second,
log in with the code `setup()` printed, and every save lands in the real sheet you can open in Drive.
That is the production wiring, minus the hosting.

## Development

```
node --test test/backend.test.mjs    # runs Code.gs in Node against an in-memory sheet
node test/dev-server.mjs             # http://localhost:8787 with seeded data; login printed in the terminal
node test/smoke.mjs                  # headless Chrome walks through login, scan, refused save, labels
```

The dev server serves `config.js` dynamically so the committed one stays pointed at production.

## How the front end talks to Apps Script

`fetch(apiUrl, { method: 'POST', body: JSON.stringify({ user, code, action, payload, batchId }) })`
with no custom headers, so the browser sends it as `text/plain` and skips the CORS preflight that Apps
Script cannot answer. The response is JSON. If a browser reports a CORS error, the deployment is not set
to "Anyone" or the URL is not the `/exec` one.

Access codes travel in the request body over HTTPS and are compared against the `Users` tab. Ten wrong
attempts for a name lock it for ten minutes. Whoever can open the sheet can read the codes; that is the
owner, and that is the intended level of protection for a movement log used by a handful of people.
