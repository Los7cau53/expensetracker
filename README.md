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
| **Settings** | Customisation first, then sync, backup, restore and Excel import |
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

**On a Mac or PC (Chrome/Edge):** `Settings → Choose a file in Drive`, and pick a
location inside your Google Drive folder (`Google Drive › My Drive` in Finder —
needs Drive for Desktop installed). The app remembers that file, so afterwards
`Save to Drive now` is one click; it overwrites in place and Drive syncs the
change and keeps the version history. iCloud Drive or Dropbox work identically —
any synced folder will do.

**On a phone:** `Settings → Share backup` hands the file to the OS share sheet;
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

## Syncing with a Google account

`Settings → Sync with Google`. Optional: signed out, the app behaves
exactly as before and every entry stays on the device.

**Dexie remains the source of truth for reads.** Firestore is a mirror, not the
store, so the app stays fully usable offline and losing Google access never
locks you out of your own ledger.

**Per-record, not whole-file.** Each record carries an `updatedAt` stamp, and a
conflict is resolved per record by that stamp. Two devices editing *different*
payments both keep their work; only a genuine same-record clash is decided by
which write came later. That is the whole reason this is not a file push.

**Deletes travel as tombstones** (`src/db/schema.ts`, `Tombstone`). A hard
delete leaves nothing behind, so the other device would push its still-present
copy back and the record would silently reappear. Tombstones are written inside
the same transaction as the delete — one written for a delete that then rolled
back would tell the other device to remove a record that still exists.

One deliberate rule: **an edit made after a delete wins**, and the record comes
back. Someone who touched a record more recently than whoever removed it should
not have it vanish under them.

Not real-time: it syncs on sign-in, every minute, on regaining focus, and on
reconnecting. A payment is not collaborative editing, and fewer moving parts is
worth more than instant propagation.

### Weight

The Firebase SDK is ~207 KB gzipped — larger than the rest of the app. It is
behind a dynamic import, given a stable chunk name, and excluded from the
precache (`globIgnores: ['**/firebase-*.js']`), so a session that never signs
in never downloads it. Verified against the production build by asserting no
request for it until sign-in is pressed. Install stays ~870 KB.

### Who can sign in

Firebase Authentication has no allowlist on the free plan: any Google account
can complete a sign-in against any project. On its own that is not a leak —
each user's documents sit under their own uid — but it does let strangers
occupy the project.

So `firestore.rules` pins the identity: a request must carry a **verified email
on the `owners()` list** *and* be writing under its own uid. Both conditions
matter — the list keeps strangers out, the uid check stops one owner writing
into another's space. Everything else in the database is unreachable.

`src/sync/owners.ts` carries the same list, but only to explain a rejection
instead of surfacing a bare `PERMISSION_DENIED`; it is not the enforcement. The
app also declines to contact the database at all for a non-owner account.

Verified against the live project: an unauthenticated read returns
`PERMISSION_DENIED`, and anonymous sign-up returns `ADMIN_ONLY_OPERATION`, so
there is no way to obtain a token without a real Google sign-in.

To add someone, add their address to `owners()` in `firestore.rules` **and** to
`OWNER_EMAILS`, then redeploy the rules.

### Setup

Firestore is in production mode, which denies everything by default, so
`firestore.rules` must be deployed before sync can work.

```bash
npx firebase-tools login
npx firebase-tools deploy --only firestore:rules --project construction-tracker-68275
```

`los7cau53.github.io` must also be listed under **Authentication → Settings →
Authorized domains**.

## Repair and reset

`Settings → Repair`.

**Merge duplicates** folds records that name the same thing twice back into
one, moving every entry across before deleting anything. Duplicates arise from
sync when two devices independently created what is really one record. The
survivor is chosen deterministically — a derived `seed-` id first, then the
oldest, then the lowest id — so every device, repairing independently, folds
the same direction.

**Delete everything** erases the ledger and starts over from the defaults,
behind a typed `delete` confirmation. When signed in it offers to delete the
copy in the Google account too, and that option is on by default: clearing only
the local copy means the next sync pulls it all straight back and the reset
looks like it silently failed. The remote is wiped **first**, so a network
failure leaves the local data intact and the reset simply retryable. No
tombstones are left behind — there is no one to tell, and they would push
deletions at a device that might hold the only remaining copy.

### The bug that made this necessary

Cost heads doubled to 46. Seeding gave a default the derived id
`seed-cat-masonry`; the legacy migration gave the same default a random UUID.
A device that migrated its old database and a device that seeded fresh
therefore held *different records* for the same "Masonry", and sync correctly
kept both.

An earlier fix had made seeding deterministic but left the migration alone, so
it only covered seed-versus-seed and not migrate-versus-seed. Both now use one
`seedId()` helper in `src/db/ids.ts`, which is why it lives there rather than
in either caller.

## Record ids and the migration off auto-increment

Ids are UUIDs (`src/db/ids.ts`), not Dexie's `++id`. That counter is private to
one device's database: a phone and a laptop would each mint payee `5` for
different people, and after any sync every `payeeId: 5` is ambiguous with no
way to untangle it. Sync is impossible without globally unique ids, so this
came first.

IndexedDB cannot change a store's primary key in place, so the app opens a new
database (`constructionLedger`) and copies the old one across on first run,
remapping every foreign key (`src/db/migrateLegacy.ts`). Two deliberate
choices:

- **The legacy database is never deleted.** If the migration is wrong, the
  original rows are still there. This is someone's financial history.
- **The ledger total is compared before and after**, and a mismatch is logged
  loudly. Migration also refuses to run into a database that already has
  entries, and refuses to run twice.

Ids being assigned centrally matters too: with `++id` gone every insert must
supply a key, and doing that at ~20 call sites means one eventually gets
missed — writing a record with `id: undefined`, silently. A Dexie `creating`
hook assigns them instead.

One consequence worth knowing: `toArray()` used to come back in insertion order
because the keys were sequential. UUID keys have no meaningful order, so any
list a reader sees — or that a default is taken from — now sorts explicitly
(`byCreated`).

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

## Managing sources, payees, cost heads and properties

All four support the same three operations, through one shared panel
(`src/components/ManagePanel.tsx`) so the guard rails and wording cannot drift
apart between them:

- **Edit** — rename, and fix whatever the importer guessed (a source's type, a
  payee's role, a property's status and budget).
- **Archive** — leaves the entity on every historical entry but removes it from
  the pickers when recording a payment. Properties use their `status` instead.
- **Merge** — moves every entry across and deletes the emptied entity. This is
  the operation an import demands, because the importer matches by name: a
  sheet spelling one account or person several ways leaves several entries for
  one real thing.
- **Delete** — refused while anything still references the entity, and refused
  for the last remaining source, cost head or property.

Cost heads live at `/categories`, reachable from **Settings → Customise → Cost
heads**. That screen is where import cleanup usually happens: the wizard files
whatever was in the chosen column as a cost head, so entries like
`net banking main form` — really a source — end up among the real ones.

Renaming is blocked only when the new name collides with a *different* entity.
An import can leave two spellings already colliding; checking unconditionally
would lock both out of every edit, type and role corrections included.

## Sources in detail

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

## Reading a Google Pay screenshot

`Add → Read a payment screenshot` fills the form from a receipt, leaving every
field editable. The one thing it never guesses is the cost head — a receipt
cannot know what the money was for.

**On-device OCR of the image is the path that has to work**, because a
screenshot taken with the volume buttons is named `IMG_4821.PNG` and carries
nothing. Amount, date, time, payee, bank and UPI reference are all recovered
from the pixels alone — verified against a real receipt under three filename
styles (`IMG_4821.PNG`, `Screenshot_20260827-174233.png`, and the re-encoded
`image.jpg` iOS produces when picking from Photos), each in about 1.4s.

**The filename is a bonus, not the mechanism.** A file shared out of Google Pay
happens to be named
`1787832753 - 16000.00 To prakash Raj Raj on Google Pay.png`, carrying the
epoch timestamp, amount and payee exactly. Where present it is preferred over
OCR — data beats a reading of pixels — but nothing depends on it.

Each extracted field is labelled with where it came from, and the raw OCR text
is shown under "What the reader saw" so a misread is visible rather than
silent. The reader also refuses to be quiet about a receipt that says **failed**
or **pending**, and flags one that reads as money *received* rather than spent.

Reading the amount is the fiddly part. OCR **drops the rupee sign entirely**
("₹16,000" comes back as "16,000"), and Google Pay writes no grouping comma
below a thousand — so demanding a currency marker would silently lose every
payment under ₹1,000, and construction is full of them. Candidates are scored
by position instead: the amount sits high on a receipt, just under the payee,
while identifiers sit far below. Lines carrying `+91`, `@`, `UPI` or a
ten-digit-plus run are excluded outright, which is what keeps the masked phone
number's tail (`26202` — numerically *larger* than the real 16,000) from
winning.

Matching: the payee is matched onto an existing one case-insensitively before a
new one is created, and the source is matched on the account's **last four
digits** first, since sources are usually named for the account rather than
exactly as the receipt spells the bank.

### Why it is built this way

- **Nothing is uploaded.** The engine, WASM core and English model are served
  from this app's own origin (`public/ocr/`, ~6.6 MB) instead of the library's
  default CDN, so the feature makes no third-party request and the screenshot
  never leaves the device. Verified by asserting no request leaves the origin.
- **Lazy and excluded from the precache.** `globIgnores: ['**/ocr/**']` keeps
  the install at ~850 KB; the engine is fetched on first use and cached by the
  service worker after that. A second read reuses the warm worker and refetches
  nothing.
- **The core is pinned** to one build rather than letting Tesseract probe for a
  variant, and its paths are absolute — handed to a web worker, a relative path
  would resolve against the worker's own URL and 404 under a `/<repo>/` subpath.

**On iPhone this is a picker, not a share sheet.** iOS Safari does not
implement Web Share Target, so an installed PWA cannot be a share destination:
pick the screenshot from Photos, or paste it. Needs WASM SIMD (Safari 16.4+).

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
