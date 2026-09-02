import { db, type FundIn, type Txn } from '../db/schema'
import { formatDate, todayStr } from './date'

const FORMAT = 'construction-expenses-backup'
const FORMAT_VERSION = 1

export interface Snapshot {
  format: typeof FORMAT
  formatVersion: number
  exportedAt: string
  counts: Record<string, number>
  data: {
    projects: unknown[]
    sources: unknown[]
    payees: unknown[]
    categories: unknown[]
    txns: unknown[]
    fundIns: unknown[]
    importBatches: unknown[]
    settings: unknown[]
  }
}

export async function buildSnapshot(): Promise<Snapshot> {
  const [projects, sources, payees, categories, txns, fundIns, importBatches, settings] =
    await Promise.all([
      db.projects.toArray(),
      db.sources.toArray(),
      db.payees.toArray(),
      db.categories.toArray(),
      db.txns.toArray(),
      db.fundIns.toArray(),
      db.importBatches.toArray(),
      db.settings.toArray(),
    ])

  return {
    format: FORMAT,
    formatVersion: FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    counts: {
      projects: projects.length,
      sources: sources.length,
      payees: payees.length,
      categories: categories.length,
      txns: txns.length,
      fundIns: fundIns.length,
    },
    data: { projects, sources, payees, categories, txns, fundIns, importBatches, settings },
  }
}

async function markBackedUp() {
  await db.settings.put({ key: 'lastBackupAt', value: Date.now() })
}

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  // Revoke on the next tick so Safari has time to start the download.
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function backupFilename(): string {
  return `construction-expenses-${todayStr()}.json`
}

/** Downloads the full database as one JSON file. Works in every browser. */
export async function downloadBackup(): Promise<string> {
  const snap = await buildSnapshot()
  const filename = backupFilename()
  triggerDownload(
    new Blob([JSON.stringify(snap, null, 2)], { type: 'application/json' }),
    filename,
  )
  await markBackedUp()
  return filename
}

// --- Share sheet (phones) -----------------------------------------------
// The route to Google Drive on a phone: hand the file to the OS share sheet
// and let the reader pick "Save to Drive". No account, no API, no tokens.

export function supportsFileShare(): boolean {
  try {
    if (typeof navigator === 'undefined' || !navigator.canShare) return false
    const probe = new File(['{}'], 'probe.json', { type: 'application/json' })
    return navigator.canShare({ files: [probe] })
  } catch {
    return false
  }
}

export type ShareOutcome = 'shared' | 'cancelled' | 'unsupported'

/**
 * Opens the OS share sheet with the backup file attached.
 *
 * `json` must already be in hand: iOS Safari only honours `navigator.share`
 * while the click's transient activation is still live, and awaiting a database
 * read first would spend it. The caller keeps a current snapshot ready so this
 * reaches `share()` synchronously.
 */
export async function shareBackupFile(json: string, filename: string): Promise<ShareOutcome> {
  if (!supportsFileShare()) return 'unsupported'

  const file = new File([json], filename, { type: 'application/json' })
  try {
    // Files only, no `text` — some targets drop the attachment when both are set.
    await navigator.share({ files: [file], title: filename })
  } catch (e) {
    // Dismissing the sheet is not a failure and must not count as a backup.
    if (e instanceof DOMException && (e.name === 'AbortError' || e.name === 'NotAllowedError')) {
      return 'cancelled'
    }
    throw e
  }

  await markBackedUp()
  return 'shared'
}

// --- File System Access API ---------------------------------------------
// Chrome desktop only. Lets the user pick one file inside iCloud/Drive once,
// then re-save to it with a single click, so backups actually happen.

export function supportsFileHandles(): boolean {
  return typeof window !== 'undefined' && 'showSaveFilePicker' in window
}

const HANDLE_KEY = 'backupFileHandle'

async function storedHandle(): Promise<FileSystemFileHandle | null> {
  const row = await db.settings.get(HANDLE_KEY)
  return (row?.value as FileSystemFileHandle | undefined) ?? null
}

export async function hasLinkedBackupFile(): Promise<boolean> {
  return (await storedHandle()) !== null
}

/**
 * The linked file's name, for display. The API deliberately withholds the full
 * path, so the name is all we can show — enough to confirm the right file was
 * picked.
 */
export async function linkedBackupName(): Promise<string | null> {
  const h = await storedHandle()
  return h?.name ?? null
}

/** Prompts once for a backup file location and remembers it. */
export async function linkBackupFile(): Promise<string | null> {
  if (!supportsFileHandles()) return null
  const handle = await (
    window as unknown as {
      showSaveFilePicker: (o: unknown) => Promise<FileSystemFileHandle>
    }
  ).showSaveFilePicker({
    // No date in the name: this file is overwritten in place, and the synced
    // folder keeps the version history.
    suggestedName: `construction-expenses.json`,
    types: [{ description: 'JSON backup', accept: { 'application/json': ['.json'] } }],
  })
  // FileSystemFileHandle is structured-cloneable, so it survives in IndexedDB.
  await db.settings.put({ key: HANDLE_KEY, value: handle })
  return handle.name
}

export async function unlinkBackupFile(): Promise<void> {
  await db.settings.delete(HANDLE_KEY)
}

/** Re-saves to the linked file. Returns false if permission was withdrawn. */
export async function saveToLinkedFile(): Promise<boolean> {
  const handle = await storedHandle()
  if (!handle) return false

  const perm = handle as unknown as {
    queryPermission: (d: unknown) => Promise<PermissionState>
    requestPermission: (d: unknown) => Promise<PermissionState>
  }
  let state = await perm.queryPermission({ mode: 'readwrite' })
  if (state !== 'granted') state = await perm.requestPermission({ mode: 'readwrite' })
  if (state !== 'granted') return false

  const snap = await buildSnapshot()
  const writable = await handle.createWritable()
  await writable.write(JSON.stringify(snap, null, 2))
  await writable.close()
  await markBackedUp()
  return true
}

// --- Restore -------------------------------------------------------------

export interface RestoreReport {
  counts: Record<string, number>
  exportedAt: string
}

export interface LedgerAge {
  txnCount: number
  fundInCount: number
  /** Epoch ms of the most recently touched entry, or null when there are none. */
  newestEntryAt: number | null
}

function ageOf(txns: Txn[], fundIns: FundIn[]): LedgerAge {
  const stamps = [
    ...txns.map((t) => Math.max(t.updatedAt ?? 0, t.createdAt ?? 0)),
    ...fundIns.map((f) => f.createdAt ?? 0),
  ].filter((n) => n > 0)

  return {
    txnCount: txns.length,
    fundInCount: fundIns.length,
    newestEntryAt: stamps.length ? Math.max(...stamps) : null,
  }
}

/** How recent the entries inside a backup file are. */
export function snapshotAge(snap: Snapshot): LedgerAge {
  return ageOf(
    (snap.data.txns ?? []) as Txn[],
    (snap.data.fundIns ?? []) as FundIn[],
  )
}

/** How recent the entries in this browser are. */
export async function localAge(): Promise<LedgerAge> {
  const [txns, fundIns] = await Promise.all([db.txns.toArray(), db.fundIns.toArray()])
  return ageOf(txns, fundIns)
}

/**
 * Whether restoring this backup would move the ledger backwards.
 *
 * Restore replaces rather than merges, so a two-device workflow can silently
 * lose work: export on the phone, forget, then restore last week's file over
 * it. Comparing the newest entry on each side turns that into a warning the
 * reader has to read past.
 */
export function wouldLoseWork(
  incoming: LedgerAge,
  local: LedgerAge,
): { stale: boolean; localNewerBy: number; entriesAtRisk: number } {
  const a = incoming.newestEntryAt ?? 0
  const b = local.newestEntryAt ?? 0
  const localTotal = local.txnCount + local.fundInCount
  const incomingTotal = incoming.txnCount + incoming.fundInCount

  return {
    // A minute of slack absorbs clock skew between two devices.
    stale: localTotal > 0 && b > a + 60_000,
    localNewerBy: Math.max(0, b - a),
    entriesAtRisk: Math.max(0, localTotal - incomingTotal),
  }
}

export function parseSnapshot(text: string): Snapshot {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('That file is not valid JSON.')
  }

  const snap = parsed as Snapshot
  if (snap?.format !== FORMAT) {
    throw new Error('That file is not a backup from this app.')
  }
  if (typeof snap.formatVersion !== 'number' || snap.formatVersion > FORMAT_VERSION) {
    throw new Error(
      `That backup was written by a newer version of the app (format ${snap.formatVersion}).`,
    )
  }
  if (!snap.data || !Array.isArray(snap.data.txns)) {
    throw new Error('That backup is missing its transaction data.')
  }
  return snap
}

/**
 * Replaces the entire database with the backup's contents. Destructive by
 * design — a partial merge would silently duplicate every row on a second
 * restore, which is worse than an explicit replace.
 */
export async function restoreSnapshot(snap: Snapshot): Promise<RestoreReport> {
  const t = snap.data
  await db.transaction(
    'rw',
    [db.projects, db.sources, db.payees, db.categories, db.txns, db.fundIns, db.importBatches, db.settings],
    async () => {
      await Promise.all([
        db.projects.clear(),
        db.sources.clear(),
        db.payees.clear(),
        db.categories.clear(),
        db.txns.clear(),
        db.fundIns.clear(),
        db.importBatches.clear(),
      ])
      await Promise.all([
        db.projects.bulkAdd(t.projects as never),
        db.sources.bulkAdd(t.sources as never),
        db.payees.bulkAdd(t.payees as never),
        db.categories.bulkAdd(t.categories as never),
        db.txns.bulkAdd(t.txns as never),
        db.fundIns.bulkAdd(t.fundIns as never),
        db.importBatches.bulkAdd((t.importBatches ?? []) as never),
      ])
      // Settings are merged, not replaced: the linked file handle and the
      // backup timestamp belong to this device, not to the snapshot.
      for (const s of (t.settings ?? []) as { key: string; value: unknown }[]) {
        if (s.key === HANDLE_KEY || s.key === 'lastBackupAt') continue
        await db.settings.put(s)
      }
    },
  )

  return {
    counts: {
      projects: t.projects.length,
      sources: t.sources.length,
      payees: t.payees.length,
      categories: t.categories.length,
      txns: t.txns.length,
      fundIns: t.fundIns.length,
    },
    exportedAt: snap.exportedAt,
  }
}

// --- CSV -----------------------------------------------------------------

function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** A flat, spreadsheet-readable dump — for a CA, a bank, or your own eyes. */
export async function downloadCsv(): Promise<string> {
  const [txns, projects, sources, payees, categories] = await Promise.all([
    db.txns.orderBy('date').toArray(),
    db.projects.toArray(),
    db.sources.toArray(),
    db.payees.toArray(),
    db.categories.toArray(),
  ])

  const name = <T extends { id: number; name: string }>(xs: T[], id?: number) =>
    id === undefined ? '' : xs.find((x) => x.id === id)?.name ?? ''

  const header = [
    'Date', 'Property', 'Paid to', 'Role', 'For what', 'Paid from',
    'Amount (INR)', 'Note', 'Reference', 'Voided',
  ]

  const rows = txns.map((t) => [
    formatDate(t.date),
    name(projects, t.projectId),
    name(payees, t.payeeId),
    t.payeeId ? payees.find((p) => p.id === t.payeeId)?.role ?? '' : '',
    name(categories, t.categoryId),
    name(sources, t.sourceId),
    (t.amount / 100).toFixed(2),
    t.note ?? '',
    t.refNo ?? '',
    t.voided ? 'yes' : '',
  ])

  const csv = [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\n')
  const filename = `construction-expenses-${todayStr()}.csv`
  // The BOM makes Excel open UTF-8 and the ₹ sign correctly.
  triggerDownload(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }), filename)
  return filename
}
