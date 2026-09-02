# Construction Expenses

A local-first PWA for tracking construction spending across several properties.
Every payment is a flow from a **fund source** (a specific bank account, cash in
hand, GPay) to a **payee** (mestri, electrician, supplier, government office)
under a **cost head**, within a **property**.

Single user, no accounts, no server. All data stays in this browser.

## Run it

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # 98 tests
npm run typecheck
npm run build      # static output in dist/
```

**Node is a build-time tool only.** There is no server, no backend and no API:
`dist/` is ~860 KB of static files, and the built app boots, registers its
service worker and works fully offline when served by `python3 -m http.server`.
Nothing in the bundle calls out to a network origin.

## Putting it on a phone

Installing needs **HTTPS** — a `http://192.168.x.x` LAN address will render the
app but is not a secure context, so no service worker, no offline, no real
install.

Pushing to `main` builds and publishes to GitHub Pages via
`.github/workflows/deploy.yml`, which runs typecheck and the test suite first so
a broken build never reaches the phone that depends on it. One-time repo setup:
**Settings → Pages → Source: GitHub Actions**. Nothing else to configure — the
app uses a relative base and hash routing, so a `/<repo>/` subpath works with no
rewrite rules (verified: service worker scope, deep links and offline reload all
hold under a subdirectory).

With a free GitHub account, Pages needs a **public** repository. That publishes
only the app's code — `.gitignore` keeps spreadsheets, CSVs and exported
backups out, and there is no server for data to sit on. Every rupee stays in
your own browser's storage.

Then, on the phone: open the Pages URL in **Safari** on iOS (Chrome on iOS
cannot install PWAs) → Share → Add to Home Screen. On Android, Chrome offers an
install prompt.

**The URL is the identity of your data.** Browser storage is per-origin, so
entries made at one address do not follow you to another. Settle on the
permanent URL before entering real expenses.

## Using two devices

There is no sync and no merge — the JSON backup is the bridge, and **restore
replaces**. So the app checks before it overwrites: if the file you are
restoring is older than what is already in this browser, it says so, by how
much, and how many entries you stand to lose, before you can proceed. A minute
of slack absorbs clock skew between devices.

The safe habit is one direction at a time: export from the device you have been
using, restore on the other, and let whichever holds the newest entries be the
one you export from next.

## Screens

| Screen | Answers |
|---|---|
| **Summary** | The dashboard: what has been spent, when, on what, from where |
| **Properties** | What has each property cost, split by cost head, source and month |
| **Ledger** | Every entry, filterable; reassign payee/source/cost head, or void |
| **Add** | The hot path — one screen, one-handed, sticky property/source/cost head |
| **Sources** | How much came into each source, how much went out, what is left; edit, archive, merge or delete one |
| **Payees** | How much each person or supplier has been given, per property |
| **Data** | Backup, restore, Excel import |

## The summary dashboard

The landing screen. One filter row at the top — property and date range — scopes
every widget below it, so the numbers always agree.

| Widget | Form | Why that form |
|---|---|---|
| Total spent | hero figure | one number, so not a chart |
| Funds in / Available / Payees | stat tiles | headline numbers, so not a grouped bar |
| Spend over time | area, one hue | trend; crosshair + tooltip finds the date |
| By month | columns, one hue | ordered magnitude |
| Where it went | bar list, one hue | ranked magnitude over nominal categories |
| Which source paid | one stacked bar, categorical | part-to-whole across a few accounts |
| Paid to | bar list, one hue | ranked magnitude |

Charting rules the code holds to, because breaking them is how dashboards start
lying:

- **One hue per single-series chart.** Colouring bars darker-where-bigger would
  double-encode the length they already show.
- **Categorical hues in one fixed order, never cycled**, and capped — the tail
  folds into a grey "Other" rather than a generated ninth colour that nobody
  with colour-vision deficiency could separate. The order was validated with
  the palette validator against this app's card surface: every hard gate passes
  (worst adjacent CVD ΔE 9.1). Three slots sit below 3:1 contrast, which is why
  every chart carries visible labels *and* a table view.
- **Negatives keep their sign.** A reversed payment gets its own row and a
  red bar growing left of the zero line. Ranking the tail by *magnitude* rather
  than signed value is what stops a −₹1.41L reversal being swept into "Other" —
  the most surprising number on the page is the last one to hide.
- **A time axis includes its empty periods.** Dropping months with no activity
  would place February next to August and read as two consecutive months.
- **No dual axes, ever.** Two measures of different scale get two charts.
- **Every chart has a table-view twin** (the `Numbers` toggle) and axis labels
  thin out rather than overlapping.

## Backup — read this

Local-first means **this browser is the only copy**. Clearing site data, or
losing the device, loses everything.

### Getting a copy into Google Drive

No account, no OAuth, no API key — the app writes a file and lets Drive's own
client do the syncing.

**On a Mac or PC (Chrome/Edge):** `Data → Choose a file in Drive`, and pick a
location inside your Google Drive folder (`Google Drive › My Drive` in Finder —
needs Drive for Desktop installed). The app remembers that file, so afterwards
`Save to Drive now` is one click; it overwrites in place and Drive syncs the
change and keeps the version history. iCloud Drive or Dropbox work identically —
any synced folder will do.

**On a phone:** `Data → Share backup` hands the file to the OS share sheet;
choose **Drive** or **Save to Drive**. Files are dated, so successive shares sit
alongside each other rather than overwriting.

**Anywhere else:** `Export backup (JSON)` downloads the file and you move it
into Drive yourself.

Why there is no "sync to Drive" button that runs on its own: a browser-only app
cannot. Google's in-browser OAuth issues short-lived access tokens with no
refresh token, so any direct Drive integration would mean re-consenting roughly
hourly and would still never run unattended. Writing into a folder Drive already
watches gives genuinely continuous sync instead, and keeps the app free of
accounts and API keys.

### The rest of the safety net

- The JSON export is the restorable one. The CSV is for reading in a
  spreadsheet and **cannot** be imported back.
- Restoring a backup is also how you move to a new phone or laptop. There is no
  device-to-device sync — export and restore is the transfer mechanism.
- The Summary screen nags once a backup is more than 7 days old, or never taken.
  Dismissing a share sheet does **not** count as a backup, so the nag correctly
  stays up.
- `navigator.storage.persist()` is requested on first run, which reduces the
  chance of eviction but is not a guarantee (Safari ignores it).

## Data model

Dexie/IndexedDB. See `src/db/schema.ts`.

- `projects`, `sources`, `payees`, `categories` — the four dimensions
- `txns` — money out. `payeeId` is nullable, for counter payments with no named
  recipient. A negative amount is a reversal or refund and nets against spend.
- `fundIns` — money *into* a source. Without these, a source has no meaningful
  balance, only a running outflow.
- `importBatches` — one per Excel import, so a whole import can be undone

Two deliberate choices:

**Money is integer paise, never floating-point rupees** (`src/lib/money.ts`).
The app's central promise is that `balance === opening + inflows − outflows`
exactly; floats break that quietly.

**Nothing is hard-deleted.** A correction sets `voided = 1`, so the amount
leaves every total but the row survives for a later dispute with a contractor.

## Excel import

`Data → Start import`. Reads `.xlsx`, `.xls`, `.csv` and `.ods` entirely in the
browser — nothing is uploaded.

The wizard is built for real hand-kept sheets, which are rarely one clean table:

- **Header detection** finds the title row that actually sits on top of the
  data, skipping template blocks stacked above it.
- **Sheets with no header at all** are detected, so row 1 is not silently eaten;
  columns are then addressed by position.
- **Cost head per sheet** defaults to the sheet name — the right default for
  workbooks organised one tab per job.
- **Fallback date** lets a sheet with no date column import at all.
- **Total and signature rows** are rejected by name rather than by luck, so a
  sheet is not double-counted.
- **Negative rows are kept negative** — a reversed online payment must reduce
  the net, not add to it. The preview shows the gross/net split.
- **Alias merging** collapses `Mesthri` / `mestri` / `MESTRI` onto one payee
  before anything is written.
- **Money-in tabs** can be imported as fund inflows instead of payments, per
  sheet. A tab recording cash withdrawals or transfers from family tops up a
  source's balance; importing it as spending would both inflate the total and
  double-count, since that money is spent again on the work tabs.
- **Dry run first**: row count, net total, and every rejected row with its
  Excel row number and the reason. Reconcile that total against your sheet
  before committing.
- **Undo** removes a whole batch.

Payee roles and source types are inferred from names (`src/lib/infer.ts`), and
the same inference runs on manual entry, so typing "Ramesh mestri" tags them a
mestri without being asked.

## Managing sources

Rows on the Sources list carry a chevron and the screen says so: **tap a source**
to reach its own screen, where **Edit** (top right) opens rename, type,
institution, opening balance and notes. Without that affordance the list reads
as a static summary and the whole screen looks read-only.

Open a source to rename it, correct the type the importer guessed, set its
institution and opening balance, or deal with it entirely:

- **Archive** — hides it when recording a payment but leaves every historical
  row pointing at it, so past reports are unchanged. For an account you have
  stopped using.
- **Merge into another source** — the one that matters after an import. A sheet
  spelling an account two ways (`sbi 4471` and `SBI 4471`) produces two sources
  for one real account; merging moves every payment and inflow across, adds the
  opening balances together, and deletes the emptied one. The combined balance
  is asserted to equal the sum of the two it replaces.
- **Delete** — refused while anything still points at the source, because a
  dangling `sourceId` would leave payments belonging to no account and silently
  break every balance. It also refuses to remove your last remaining source.

Renaming is blocked only when the new name collides with a *different* source.
An import can leave two spellings of one account already colliding; checking
unconditionally would lock both out of every edit, including fixing their type.

## Cleaning up imported history

Hand-kept sheets usually mix the fund source and the purpose into one
free-text column, and often have no payee column at all, so imported rows
arrive with no payee and on a fallback source. Fix them in the ledger: tap a
row to expand it and reassign **payee** (creating one inline), **cost head**,
**source** and **property**. Amounts and dates are left alone unless you
change them. Rows with no payee are labelled by their note or cost head rather
than a row of identical "Unassigned" entries.

## Tests

```bash
npm test
```

- `src/lib/money.test.ts` — parsing, Indian grouping, no float drift
- `src/lib/date.test.ts` — day-first vs month-first, Excel serials, and the
  lenient-platform-parser trap (`new Date('#111111')` is the year 111110)
- `src/db/ledger.test.ts` — the balance identity, voiding, breakdowns
  reconciling to the same total, and a full export→wipe→restore round trip
- `src/lib/share.test.ts` — the share-sheet route: one JSON file and no text
  payload, a dismissed sheet never recorded as a backup, and a shared file that
  still restores cleanly
- `src/lib/excelImport.test.ts` — including fixtures modelled on real sheet
  shapes: no headers, reversed column order, embedded totals, a missing date
  column, a reversal row
- `src/db/manage.test.ts` — editing, archiving, merging and deleting sources,
  including the invariant that a merge preserves the combined balance exactly
- `src/db/summary.test.ts` — the dashboard's aggregation: netting reversals,
  ignoring voided rows, a continuous month axis, magnitude-ranked tails, and
  every breakdown reconciling to the same total
- `src/test/app.test.tsx` — renders every screen, records a payment through the
  real UI, and reassigns an imported row

The suite is backed by Playwright runs against the real workbook: 41 end-to-end
checks (imports, undo, backup, reassignment), 22 chart checks (crosshair
tooltip, keyboard parity, hit-target sizes, table-view twins, legend presence,
filter scoping), 24 Drive-route checks (the desktop and phone paths offered on
the right devices, the shared payload, and the nag standing down only on a real
save), and 10 offline/PWA checks on the production build — service worker
active, full reload with the network disabled, entries added offline.

## Not in this version

- Bill/receipt photos. Image blobs in IndexedDB worsen the eviction risk and
  bloat every export.
- Cross-device sync. Export/restore instead — an explicit limitation.
- Quantity/rate reconciliation, committed-vs-paid, read-only share links.
