# inventory-scanner — the repository's working brief

Read `README.md` first: it is the whole system in one page (parts, setup, rules, sheet layout).
This file is what an agent needs beyond that.

**What it is.** Phone QR scanning for equipment movement, backed by one Google Sheet through one Apps Script.
Static front end, no build step, no framework, no CI. Deliberately boring; keep it that way.

**Where things are.**
- `index.html` + `app.js` + `app.css`: the whole front end. `app.js` is one IIFE; sections are marked
  `// ---------- name ----------`. `window.inventoryApp` exposes a few functions for the smoke test only.
- `apps-script/Code.gs`: the backend. `handleRequest(body)` is pure (no HTTP objects) so Node can run it.
  Handlers are `h*` functions; every mutating one runs under the script lock and returns a fresh snapshot.
- `test/fake-gas.mjs`: an in-memory stand-in for `SpreadsheetApp`, `LockService`, `CacheService`,
  `Utilities`, `ContentService`. If `Code.gs` starts using another Sheets method, add it there.
- `vendor/`: pinned libraries with checksums. Do not update them casually.

**Rules.**
- Keep every function of the original prototype working: dashboard, condition check, check-out,
  check-in, inventory list with edit/deactivate, cabinets and boxes with grouping, QR printing, history.
- The sheet layout in `README.md` is the contract with people who edit the sheet by hand. Add columns at
  the end only, and add them to the `*_COLS` arrays and `setup()`.
- The app records where an item is. Never add ownership, price or depreciation: the asset register is ICMS.
- No new dependencies, no build tools, no service worker, nothing that needs a yearly update.
- `config.js` holds the production Apps Script URL; the dev server overrides it, never edit it for local work.
- Commit in this repository only. Messages end with the attribution footer this environment requires.

**Before claiming a change works:** `node --test test/backend.test.mjs` and `node test/smoke.mjs`
(needs Google Chrome). The smoke test runs the real `Code.gs` behind the real front end.
