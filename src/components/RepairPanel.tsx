import { useLiveQuery } from 'dexie-react-hooks'
import { useState } from 'react'
import { Button, Card } from './ui'
import { findDuplicates, hardReset, mergeDuplicates } from '../db/repair'
import { db } from '../db/schema'

const TABLE_LABEL: Record<string, string> = {
  projects: 'properties',
  sources: 'fund sources',
  payees: 'payees',
  categories: 'cost heads',
}

/**
 * Repair and reset.
 *
 * Duplicates arise from sync when two devices independently created what is
 * really one record. Merging is offered before resetting because it keeps the
 * ledger; reset is the blunt instrument and is behind a typed confirmation.
 */
export function RepairPanel({ uid }: { uid: string | null }) {
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirmText, setConfirmText] = useState('')
  const [showReset, setShowReset] = useState(false)
  const [alsoRemote, setAlsoRemote] = useState(true)

  const dupes = useLiveQuery(() => findDuplicates(), [], null)
  const entryCount = useLiveQuery(() => db.txns.count(), [], 0)

  async function run(fn: () => Promise<string>) {
    setBusy(true)
    setError(null)
    setStatus(null)
    try {
      setStatus(await fn())
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That did not work.')
    } finally {
      setBusy(false)
    }
  }

  const byTable = (dupes?.groups ?? []).reduce<Record<string, number>>((acc, g) => {
    acc[g.table] = (acc[g.table] ?? 0) + g.mergeIds.length
    return acc
  }, {})

  return (
    <Card className="space-y-4 p-4">
      <div>
        <h2 className="font-semibold">Repair</h2>
        <p className="mt-1 text-sm text-muted">
          Two devices can each create what is really one record — the same cost head twice, say.
          Merging folds them back together and moves every entry across first, so nothing is lost.
        </p>
      </div>

      {dupes && dupes.totalExtra > 0 ? (
        <div className="rounded-lg border border-out/30 bg-out/5 p-3">
          <p className="text-sm">
            <strong>{dupes.totalExtra} duplicate {dupes.totalExtra === 1 ? 'record' : 'records'}</strong>{' '}
            found:{' '}
            {Object.entries(byTable)
              .map(([t, n]) => `${n} ${TABLE_LABEL[t] ?? t}`)
              .join(', ')}
            .
          </p>
          <Button
            className="mt-2"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const r = await mergeDuplicates()
                return `Merged ${r.merged} duplicates, moving ${r.movedEntries} entries.`
              })
            }
          >
            Merge duplicates
          </Button>
        </div>
      ) : (
        <p className="text-sm text-muted">No duplicates found.</p>
      )}

      <div className="border-t border-line pt-4">
        <h3 className="text-sm font-semibold text-out">Delete everything</h3>
        <p className="mt-1 text-sm text-muted">
          Erases every property, source, payee, cost head, payment and inflow, and starts over from
          the defaults. There is no undo.
        </p>

        {!showReset ? (
          <Button variant="danger" className="mt-2" onClick={() => setShowReset(true)}>
            Delete everything…
          </Button>
        ) : (
          <div className="mt-2 space-y-3 rounded-lg border border-out/40 bg-out/5 p-3">
            <p className="text-sm">
              This will erase <strong>{entryCount} {entryCount === 1 ? 'entry' : 'entries'}</strong>{' '}
              on this device. Export a backup first if there is any doubt.
            </p>

            {uid ? (
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={alsoRemote}
                  onChange={(e) => setAlsoRemote(e.target.checked)}
                />
                <span>
                  Also delete the copy in your Google account
                  <span className="mt-0.5 block text-xs text-muted">
                    Leave this on. Clearing only this device means the next sync pulls everything
                    straight back, and the reset will look like it silently failed.
                  </span>
                </span>
              </label>
            ) : (
              <p className="text-xs text-muted">
                You are signed out, so only this device is affected. If a copy exists in your Google
                account, signing in later will pull it back.
              </p>
            )}

            <label className="block text-sm">
              <span className="mb-1 block text-muted">
                Type <strong className="text-ink">delete</strong> to confirm
              </span>
              <input
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                autoComplete="off"
                className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-base outline-none focus:border-accent"
              />
            </label>

            <div className="flex gap-2">
              <Button
                variant="danger"
                disabled={busy || confirmText.trim().toLowerCase() !== 'delete'}
                onClick={() =>
                  void run(async () => {
                    const wipe =
                      uid && alsoRemote
                        ? async () => {
                            const { wipeRemote } = await import('../sync/firestore')
                            return wipeRemote(uid)
                          }
                        : undefined
                    const r = await hardReset(
                      { includeRemote: Boolean(uid && alsoRemote), includeLegacy: true },
                      wipe,
                    )
                    setShowReset(false)
                    setConfirmText('')
                    // A reload re-seeds the defaults and clears every screen's
                    // cached query, rather than leaving the UI half-empty.
                    setTimeout(() => window.location.reload(), 1200)
                    return `Deleted ${r.localCleared} records here${
                      r.remoteDeleted ? ` and ${r.remoteDeleted} in Google` : ''
                    }. Reloading…`
                  })
                }
              >
                Delete everything
              </Button>
              <Button
                variant="secondary"
                onClick={() => {
                  setShowReset(false)
                  setConfirmText('')
                }}
              >
                Cancel
              </Button>
            </div>
          </div>
        )}
      </div>

      {status && (
        <p className="rounded-lg bg-in/10 px-3 py-2 text-sm font-medium text-in">{status}</p>
      )}
      {error && (
        <p className="rounded-lg bg-out/10 px-3 py-2 text-sm font-medium text-out">{error}</p>
      )}
    </Card>
  )
}
