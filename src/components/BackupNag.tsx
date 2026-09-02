import { useLiveQuery } from 'dexie-react-hooks'
import { Link } from 'react-router-dom'
import { db } from '../db/schema'
import { daysSince } from '../lib/date'

/**
 * The single most important warning in a local-first app: browser storage is
 * the only copy. Lives on whichever screen the app lands on, shown once a
 * backup is a week old and always when there has never been one.
 */
export function BackupNag() {
  const lastBackup = useLiveQuery(() => db.settings.get('lastBackupAt'), [])
  const txnCount = useLiveQuery(() => db.txns.count(), [], 0)

  if (txnCount === 0) return null

  const ts = lastBackup?.value as number | null | undefined
  const days = ts ? daysSince(ts) : null
  if (days !== null && days <= 7) return null

  return (
    <Link to="/data" className="block rounded-xl border border-out/30 bg-out/5 px-4 py-3 text-sm">
      <strong className="font-semibold text-out">
        {days === null ? 'No backup yet' : `Last backup was ${days} days ago`}
      </strong>
      <span className="mt-0.5 block text-muted">
        This data lives only in this browser. Clearing site data would lose it — export a backup
        now.
      </span>
    </Link>
  )
}
