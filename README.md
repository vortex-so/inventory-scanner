# Inventory Scanner

Phones scan the QR labels on equipment to check it out, check it back in, record its condition and group
it into cabinets and boxes. Every scan lands in a Google Sheet. Built for the Neutron LED screen that
Vortex's media team and KPTJ run; offered to other units later.

It replaces an earlier Apps Script prototype whose camera lived on a second browser tab. Here the camera,
the cart and the Save button are on one page, so a scan cannot get lost, and a USB scanner or typed ID
goes into the same field.

**Parts, and that is all of them**

| Part | What | Where |
|---|---|---|
| Front end | `index.html`, `app.js`, `app.css`, `config.js`, manifest and icons | any static host, this repo's Pages |
| Backend | `apps-script/Code.gs` | pasted into the Apps Script bound to the sheet |
| Store | one Google Sheet with tabs `Items`, `Containers`, `Transactions`, `Users` | a company Google account |
| Libraries | `vendor/` (QR scanning, QR drawing), pinned, self-hosted | see `vendor/README.md` |

No build step, no CI, no service worker, no npm. Deploy is a push. The sheet is the database, the admin
panel and the backup (File › Version history).

## One-time setup

1. **Sheet.** In the company Google account create a blank Google Sheet, name it e.g. `Inventaris LED`.
2. **Script.** In the sheet: Extensions › Apps Script. Replace the contents of `Code.gs` with
   `apps-script/Code.gs` from this repo. Project Settings › tick "Show appsscript.json", replace it with
   `apps-script/appsscript.json`. Save.
3. **Tabs and admin.** In the editor pick the function `setup` and Run. Approve the permissions (it only
   touches this sheet). Open Executions or the log: it prints `name=admin code=NNNNNN`. The `Users` tab now
   holds that admin row. Add one row per person: `name`, `code`, `role` (`admin` or `operator`), `active` = `TRUE`.
   Operators can scan, save and group; admins can also import, edit and deactivate items.
4. **Deploy.** Deploy › New deployment › type Web app › Execute as **Me** · Who has access **Anyone** ›
   Deploy. Copy the URL ending in `/exec`.
5. **Front end.** Put the URL into `config.js` (`apiUrl`). Commit and push. Enable Pages on the repo
   (GitHub: Settings › Pages › Deploy from branch `main`, folder `/`). Open the Pages URL on a phone,
   log in with name and code, tap Add to Home Screen.
6. **Items.** Admin › Inventaris › Tambah aset: paste the printed IDs (one per line) with their type and
   name. Or import from the existing sheet, see below.

After any change to `Code.gs`: paste the new file, then Deploy › Manage deployments › edit › New version.
The URL stays the same.

## Everyday use

- **Scan.** Pick the flow at the top (Cek Kondisi · Keluar · Masuk · Kelompok), start the camera, point
  at labels; each hit vibrates and appears in the cart. Typing an ID or a USB scanner's keystrokes into the
  field below the camera does the same. Fill the form, Save.
- **Boxes.** A container whose ID is the printed box label (e.g. `2-MVG-12-25-NY-BX.001`) is special:
  scanning that label puts the whole contents in the cart (and the box itself if it is also an item).
  In the Kelompok flow, scan the box first and then the modules going into it.
- **Rules the server enforces.** Out only from the warehouse, in only when out, a damaged check needs a
  note, a date and location are required, unknown IDs are refused. A refused save names the offending IDs
  and the app removes them from the cart so you can save the rest.
- **Retries are safe.** Every save carries a batch id; a repeat after a timeout is not written twice.
- **Labels.** Cetak QR (menu ⋯) draws QR codes in the browser; print at 100 % scale. Sizes 15, 20, 25 mm.

## The sheet

| Tab | Columns |
|---|---|
| `Items` | id · qr_value · type · name · category · location · status (`DI GUDANG`/`DI LUAR`) · condition (`BAIK`/`RUSAK`/empty) · damage_note · cabinet_id · active · created_at · updated_at · last_checked_at · last_user |
| `Containers` | cabinet_id · container_type (`KABINET`/`BOX`) · name · category · note · active · created_at · updated_at |
| `Transactions` | ts · batch_id · action · item_id · item_name · item_type · event_date · location · event_name · cabinet_id · condition · damage_note · note · user |
| `Users` | name · code · role · active |

Transactions is append-only and is the history. Items and Containers hold current state and may be fixed
by hand in the sheet; the app reads the sheet fresh on every call. `setup()` formats all cells as plain
text so IDs and codes come back exactly as typed. No price, owner or depreciation columns: this app
records where a thing is, the asset register lives elsewhere.

**Migrating from the earlier prototype's sheet.** Export its items as CSV, then either paste the IDs per
type into Tambah aset, or paste rows straight into `Items` with the columns above (set `active` to `TRUE`,
`status` to `DI GUDANG` or `DI LUAR`). Containers likewise. Old history can be pasted into `Transactions`
with the same column order; `batch_id` may be empty.

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
