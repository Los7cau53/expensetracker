import { Button, Card } from './ui'
import { OWNER_EMAILS } from '../sync/owners'
import { useSync } from '../sync/useSync'

/**
 * Sign-in and sync status.
 *
 * States the two things a reader needs to trust it: when it last synced, and
 * that the local copy still works on its own.
 */
export function SyncPanel() {
  const { user, status, lastResult, lastSyncedAt, error, signIn, signOut, syncNow } = useSync()

  return (
    <Card className="space-y-3 p-4">
      <div>
        <h2 className="font-semibold">Sync with Google</h2>
        <p className="mt-1 text-sm text-muted">
          {user
            ? 'Your ledger is copied to your Google account and kept in step across devices.'
            : 'Sign in to keep this ledger in step across your phone and laptop. Without it the app still works — everything stays on this device.'}
        </p>
      </div>

      {user && status === 'notAllowed' ? (
        <>
          <div className="rounded-lg border border-out/40 bg-out/5 px-3 py-2 text-sm">
            <div className="font-semibold text-out">This account cannot sync</div>
            <div className="mt-1 text-muted">
              Signed in as <strong className="text-ink">{user.email}</strong>, which is not on the
              allowlist. Only {OWNER_EMAILS.join(', ')} can read or write this ledger — enforced by
              the database rules, not just here.
            </div>
            <div className="mt-1 text-muted">
              Nothing on this device has changed, and it all still works offline.
            </div>
          </div>
          <Button variant="secondary" onClick={() => void signOut()}>
            Sign out and try another account
          </Button>
        </>
      ) : user ? (
        <>
          <div className="rounded-lg border border-line bg-ground/50 px-3 py-2 text-sm">
            <div className="font-medium">{user.email ?? user.displayName ?? 'Signed in'}</div>
            <div className="mt-0.5 text-xs text-muted">
              {status === 'syncing' && 'Syncing…'}
              {status === 'offline' && 'Offline — will sync when the connection returns.'}
              {status === 'error' && 'Last sync failed.'}
              {status === 'idle' &&
                (lastSyncedAt
                  ? `Last synced ${new Date(lastSyncedAt).toLocaleString('en-IN')}`
                  : 'Not synced yet.')}
            </div>
            {lastResult && status === 'idle' && (
              <div className="mt-1 text-xs text-muted">
                {lastResult.pushed} sent · {lastResult.applied} received
                {lastResult.deletedLocally > 0 ? ` · ${lastResult.deletedLocally} removed here` : ''}
              </div>
            )}
          </div>

          <div className="flex flex-wrap gap-2">
            <Button onClick={() => void syncNow()} disabled={status === 'syncing'}>
              {status === 'syncing' ? 'Syncing…' : 'Sync now'}
            </Button>
            <Button variant="secondary" onClick={() => void signOut()}>
              Sign out
            </Button>
          </div>
          <p className="text-xs text-muted">
            Signing out leaves every entry on this device. It only stops the copying.
          </p>
        </>
      ) : (
        <Button onClick={() => void signIn()}>Sign in with Google</Button>
      )}

      {error && (
        <p className="rounded-lg bg-out/10 px-3 py-2 text-sm font-medium text-out">{error}</p>
      )}
    </Card>
  )
}
