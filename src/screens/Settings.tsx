import { useLiveQuery } from 'dexie-react-hooks'
import { lazy, Suspense, useState } from 'react'
import { Link } from 'react-router-dom'
import { SyncPanel } from '../components/SyncPanel'
import { Button, Card, Money, Screen, Stat } from '../components/ui'
import { sum } from '../db/queries'
import { db } from '../db/schema'
import {
  backupFilename,
  buildSnapshot,
  downloadBackup,
  downloadCsv,
  hasLinkedBackupFile,
  linkBackupFile,
  linkedBackupName,
  localAge,
  parseSnapshot,
  restoreSnapshot,
  saveToLinkedFile,
  shareBackupFile,
  snapshotAge,
  supportsFileHandles,
  supportsFileShare,
  unlinkBackupFile,
  wouldLoseWork,
  type Snapshot,
} from '../lib/backup'
import { daysSince, formatDate } from '../lib/date'
import { undoImport } from '../db/imports'

// SheetJS is ~450 kB and is only needed during an import, so it stays out of
// the initial bundle — this app has to open fast on a phone at a site.
const ImportWizard = lazy(() =>
  import('../components/ImportWizard').then((m) => ({ default: m.ImportWizard })),
)

export default function Settings() {
  const [importing, setImporting] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirmRestore, setConfirmRestore] = useState<{
    file: File
    snap: Snapshot
    stale: boolean
    localNewerBy: number
    entriesAtRisk: number
    incomingCount: number
  } | null>(null)

  const lastBackup = useLiveQuery(() => db.settings.get('lastBackupAt'), [])
  const linked = useLiveQuery(() => hasLinkedBackupFile(), [], false)
  const linkedName = useLiveQuery(() => linkedBackupName(), [], null)

  // Kept current so the share handler can reach navigator.share() without an
  // await — iOS Safari spends the click's activation on any intervening one.
  const snapshotJson = useLiveQuery(
    async () => JSON.stringify(await buildSnapshot(), null, 2),
    [],
    null,
  )
  const batches = useLiveQuery(() => db.importBatches.orderBy('importedAt').reverse().toArray(), [], [])
  const txns = useLiveQuery(() => db.txns.where('voided').equals(0).toArray(), [], [])

  const ts = lastBackup?.value as number | null | undefined
  const days = ts ? daysSince(ts) : null

  function report(fn: () => Promise<string | boolean | null | void>, ok: string) {
    setError(null)
    setStatus(null)
    fn()
      .then((r) => setStatus(r === false ? 'Permission denied for the linked file.' : ok))
      .catch((e) => setError(e instanceof Error ? e.message : 'That did not work.'))
  }

  /** Reads and checks the file before offering to restore it. */
  async function inspectRestore(file: File) {
    setError(null)
    setStatus(null)
    try {
      const snap = parseSnapshot(await file.text())
      const incoming = snapshotAge(snap)
      const verdict = wouldLoseWork(incoming, await localAge())
      setConfirmRestore({
        file,
        snap,
        ...verdict,
        incomingCount: incoming.txnCount + incoming.fundInCount,
      })
    } catch (e) {
      setConfirmRestore(null)
      setError(e instanceof Error ? e.message : 'That file could not be read.')
    }
  }

  async function doRestore(snap: Snapshot) {
    setError(null)
    setStatus(null)
    try {
      const res = await restoreSnapshot(snap)
      setStatus(
        `Restored ${res.counts.txns} entries from the backup taken ${new Date(
          res.exportedAt,
        ).toLocaleString('en-IN')}.`,
      )
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Restore failed.')
    } finally {
      setConfirmRestore(null)
    }
  }

  return (
    <Screen title="Settings">
      <div className="mx-auto max-w-2xl space-y-4">
        {/* Customisation used to live inside a screen called "Data & backup",
            several panels down. These sit at the top because they are what
            someone opening Settings is usually looking for. */}
        <Card className="p-4">
          <h2 className="font-semibold">Customise</h2>
          <p className="mt-1 text-sm text-muted">
            Rename, merge, archive or delete the things payments are filed against.
          </p>
          <ul className="mt-3 divide-y divide-line">
            {[
              { to: '/categories', label: 'Cost heads', hint: 'What a payment was for' },
              { to: '/properties', label: 'Properties', hint: 'Budgets and per-property spend' },
              { to: '/sources', label: 'Fund sources', hint: 'Accounts money is paid from' },
              { to: '/payees', label: 'Payees', hint: 'People and suppliers paid' },
            ].map((row) => (
              <li key={row.to}>
                <Link
                  to={row.to}
                  className="flex items-center gap-3 py-2.5 first:pt-0 hover:opacity-70"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium">{row.label}</span>
                    <span className="block text-xs text-muted">{row.hint}</span>
                  </span>
                  <span aria-hidden className="shrink-0 text-lg leading-none text-muted">›</span>
                </Link>
              </li>
            ))}
          </ul>
        </Card>

        <SyncPanel />

        <div className="grid grid-cols-2 gap-3">
          <Stat label="Entries" value={txns.length} />
          <Stat label="Recorded" value={<Money paise={sum(txns.map((t) => t.amount))} />} />
        </div>

        <Card
          // Only alarming once there is something to lose — a fresh install
          // has no backup and needs none.
          className={`space-y-3 p-4 ${
            txns.length > 0 && (days === null || days > 7) ? 'border-out/40 bg-out/5' : ''
          }`}
        >
          <div>
            <h2 className="font-semibold">Backup</h2>
            <p className="mt-1 text-sm text-muted">
              {ts
                ? `Last backup ${formatDate(new Date(ts).toISOString().slice(0, 10))} (${days} ${
                    days === 1 ? 'day' : 'days'
                  } ago).`
                : txns.length > 0
                  ? 'You have never taken a backup.'
                  : 'Nothing recorded yet, so nothing to back up.'}{' '}
              This app keeps everything in this browser only — nothing is uploaded anywhere. If you
              clear site data or lose this device, an export file is the only way back.
            </p>
          </div>

          {/* Google Drive, without an account or an API: on desktop, write into
              the folder Drive already syncs; on a phone, hand the file to the
              share sheet. */}
          <div className="rounded-lg border border-accent/30 bg-accent/5 p-3">
            <h3 className="text-sm font-semibold">Keep a copy in Google Drive</h3>

            {supportsFileHandles() ? (
              linked ? (
                <>
                  <p className="mt-1 text-sm text-muted">
                    Linked to <strong className="text-ink">{linkedName ?? 'a file'}</strong>. Saving
                    overwrites it in place, and Drive syncs the change on its own.
                  </p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Button onClick={() => report(saveToLinkedFile, 'Saved. Drive will sync it.')}>
                      Save to Drive now
                    </Button>
                    <Button variant="secondary" onClick={() => report(unlinkBackupFile, 'Unlinked.')}>
                      Unlink
                    </Button>
                  </div>
                </>
              ) : (
                <>
                  <p className="mt-1 text-sm text-muted">
                    Pick a file once inside your Google Drive folder — under{' '}
                    <span className="font-medium text-ink">Google Drive › My Drive</span> in Finder,
                    which needs Drive for Desktop installed. After that it is one click, and Drive
                    handles the syncing and the version history.
                  </p>
                  <div className="mt-2">
                    <Button onClick={() => report(linkBackupFile, 'Linked. Now press Save to Drive.')}>
                      Choose a file in Drive
                    </Button>
                  </div>
                  <p className="mt-2 text-xs text-muted">
                    iCloud Drive or Dropbox work exactly the same way — any synced folder will do.
                  </p>
                </>
              )
            ) : supportsFileShare() ? (
              <>
                <p className="mt-1 text-sm text-muted">
                  Send the backup to the Drive app: press Share, then choose{' '}
                  <span className="font-medium text-ink">Drive</span> or{' '}
                  <span className="font-medium text-ink">Save to Drive</span> in the share sheet.
                </p>
                <div className="mt-2">
                  <Button
                    disabled={!snapshotJson}
                    onClick={() => {
                      if (!snapshotJson) return
                      setError(null)
                      setStatus(null)
                      // No await before share(): iOS needs the click's activation.
                      shareBackupFile(snapshotJson, backupFilename())
                        .then((outcome) => {
                          if (outcome === 'shared') setStatus('Backup shared.')
                          else if (outcome === 'unsupported') setError('Sharing is not available here — use Export backup instead.')
                        })
                        .catch((e) =>
                          setError(e instanceof Error ? e.message : 'Sharing failed.'),
                        )
                    }}
                  >
                    Share backup
                  </Button>
                </div>
              </>
            ) : (
              <p className="mt-1 text-sm text-muted">
                This browser offers neither a file picker nor a share sheet. Export the backup below
                and move the downloaded file into Drive yourself.
              </p>
            )}
          </div>

          <div>
            <h3 className="text-sm font-semibold">Or export a file</h3>
            <div className="mt-2 flex flex-wrap gap-2">
              <Button
                variant="secondary"
                onClick={() => report(downloadBackup, 'Backup file downloaded.')}
              >
                Export backup (JSON)
              </Button>
              <Button variant="secondary" onClick={() => report(downloadCsv, 'CSV downloaded.')}>
                Export CSV
              </Button>
            </div>
            <p className="mt-2 text-xs text-muted">
              The JSON file is the one that can be restored. The CSV is for reading in a
              spreadsheet — it cannot be imported back.
            </p>
          </div>
        </Card>

        <Card className="space-y-3 p-4">
          <div>
            <h2 className="font-semibold">Restore</h2>
            <p className="mt-1 text-sm text-muted">
              Replaces everything currently in this browser with the backup's contents — it does
              not merge. Use it to move to a new phone or laptop, or to carry entries between two
              devices.
            </p>
          </div>
          <input
            type="file"
            accept=".json"
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) void inspectRestore(f)
            }}
            className="w-full text-sm"
          />
          {confirmRestore && (
            <div className="rounded-lg border border-out/40 bg-out/5 p-3">
              {confirmRestore.stale && (
                <p className="mb-2 text-sm font-semibold text-out">
                  This backup is older than what is already here — by{' '}
                  {describeGap(confirmRestore.localNewerBy)}.
                  {confirmRestore.entriesAtRisk > 0
                    ? ` You would lose ${confirmRestore.entriesAtRisk} ${
                        confirmRestore.entriesAtRisk === 1 ? 'entry' : 'entries'
                      }.`
                    : ' Newer edits here would be discarded.'}
                </p>
              )}
              <p className="text-sm">
                Restoring <strong>{confirmRestore.file.name}</strong> replaces the{' '}
                {txns.length} {txns.length === 1 ? 'entry' : 'entries'} stored here with the{' '}
                {confirmRestore.incomingCount} in the file. There is no merge.
                {confirmRestore.stale && ' Export this device first if you are unsure.'}
              </p>
              <div className="mt-2 flex gap-2">
                <Button variant="danger" onClick={() => void doRestore(confirmRestore.snap)}>
                  {confirmRestore.stale ? 'Restore the older file anyway' : 'Replace and restore'}
                </Button>
                <Button variant="secondary" onClick={() => setConfirmRestore(null)}>
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </Card>

        {importing ? (
          <Suspense fallback={<Card className="p-4 text-sm text-muted">Loading importer…</Card>}>
            <ImportWizard onDone={() => setImporting(false)} />
          </Suspense>
        ) : (
          <Card className="space-y-3 p-4">
            <div>
              <h2 className="font-semibold">Import from Excel</h2>
              <p className="mt-1 text-sm text-muted">
                Bring your existing sheet in. You map the columns, see exactly what will be imported
                and what will be skipped, and can undo the whole batch afterwards.
              </p>
            </div>
            <Button onClick={() => setImporting(true)}>Start import</Button>
          </Card>
        )}

        {batches.length > 0 && (
          <Card className="divide-y divide-line">
            <div className="px-4 py-3">
              <h2 className="font-semibold">Past imports</h2>
            </div>
            {batches.map((b) => (
              <div key={b.id} className="flex items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">
                    {b.fileName} · {b.sheetName}
                  </div>
                  <div className="text-xs text-muted">
                    {b.rowCount} entries · {new Date(b.importedAt).toLocaleString('en-IN')}
                  </div>
                </div>
                <Button
                  variant="danger"
                  onClick={() =>
                    report(
                      async () => {
                        const n = await undoImport(b.id)
                        return String(n)
                      },
                      'Import batch removed.',
                    )
                  }
                >
                  Undo
                </Button>
              </div>
            ))}
          </Card>
        )}

        {status && <p className="rounded-lg bg-in/10 px-3 py-2 text-sm font-medium text-in">{status}</p>}
        {error && <p className="rounded-lg bg-out/10 px-3 py-2 text-sm font-medium text-out">{error}</p>}

        <Link to="/" className="block px-1 text-sm text-accent">← Summary</Link>
      </div>
    </Screen>
  )
}

/** "3 days" / "4 hours" / "12 minutes" — enough to judge the risk. */
function describeGap(ms: number): string {
  const mins = Math.round(ms / 60_000)
  if (mins < 60) return `${mins} ${mins === 1 ? 'minute' : 'minutes'}`
  const hours = Math.round(mins / 60)
  if (hours < 48) return `${hours} ${hours === 1 ? 'hour' : 'hours'}`
  const days = Math.round(hours / 24)
  return `${days} ${days === 1 ? 'day' : 'days'}`
}
