import { useCallback, useEffect, useRef, useState } from 'react'
import { db } from '../db/schema'
import { syncOnce } from './engine'
import { createFirestoreRemote } from './firestore'
import { signInWithGoogle, signOutOfGoogle, watchUser, type User } from './firebase'
import { isOwner } from './owners'
import type { SyncResult } from './types'

export type SyncStatus =
  | 'signedOut'
  | 'idle'
  | 'syncing'
  | 'offline'
  | 'error'
  /** Signed in, but with an account that is not on the allowlist. */
  | 'notAllowed'

const LAST_SYNC_KEY = 'lastSyncedAt'
const SYNC_ENABLED_KEY = 'ce.syncEnabled'
const INTERVAL_MS = 60_000

export interface SyncState {
  user: User | null
  status: SyncStatus
  lastResult: SyncResult | null
  lastSyncedAt: number | null
  error: string | null
  signIn: () => Promise<void>
  signOut: () => Promise<void>
  syncNow: () => Promise<void>
}

/**
 * Wires the sync engine to the signed-in Google account.
 *
 * Deliberately not real-time. A payment is not collaborative editing, and
 * polling on a minute — plus on regaining focus and on reconnecting — keeps
 * the moving parts few. The local database stays the source of truth for
 * reads, so the app is fully usable signed out and offline.
 */
export function useSync(): SyncState {
  const [user, setUser] = useState<User | null>(null)
  const [status, setStatus] = useState<SyncStatus>('signedOut')
  const [lastResult, setLastResult] = useState<SyncResult | null>(null)
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Guards against a manual press landing on top of the interval's pass.
  const running = useRef(false)

  // Watching auth loads the SDK, so it only happens for someone who has
  // signed in before or is signing in now. A session that never touches sync
  // never downloads it.
  const [wantsSync, setWantsSync] = useState(() => {
    try {
      return localStorage.getItem(SYNC_ENABLED_KEY) === '1'
    } catch {
      return false
    }
  })

  useEffect(() => {
    if (!wantsSync) return
    let stop: (() => void) | undefined
    let cancelled = false

    void watchUser((u) => {
      setUser(u)
      if (!u) setStatus('signedOut')
      else setStatus(isOwner(u.email) ? 'idle' : 'notAllowed')
    })
      .then((unsub) => {
        if (cancelled) unsub()
        else stop = unsub
      })
      .catch((e: unknown) => {
        setStatus('error')
        setError(e instanceof Error ? e.message : 'Could not reach Google sign-in.')
      })

    return () => {
      cancelled = true
      stop?.()
    }
  }, [wantsSync])

  useEffect(() => {
    void db.settings.get(LAST_SYNC_KEY).then((row) => {
      if (typeof row?.value === 'number') setLastSyncedAt(row.value)
    })
  }, [])

  const syncNow = useCallback(async () => {
    if (!user || running.current) return
    // Attempting it would only earn a PERMISSION_DENIED from the rules.
    if (!isOwner(user.email)) {
      setStatus('notAllowed')
      return
    }
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      setStatus('offline')
      return
    }

    running.current = true
    setStatus('syncing')
    setError(null)
    try {
      const result = await syncOnce(await createFirestoreRemote(user.uid))
      setLastResult(result)
      setLastSyncedAt(result.ranAt)
      await db.settings.put({ key: LAST_SYNC_KEY, value: result.ranAt })
      setStatus('idle')
    } catch (e) {
      setStatus('error')
      setError(e instanceof Error ? e.message : 'Sync failed.')
    } finally {
      running.current = false
    }
  }, [user])

  // Sync on sign-in, on a timer, and whenever the app is brought back.
  useEffect(() => {
    if (!user || !isOwner(user.email)) return
    // Deferred for the same reason: syncNow sets state, and doing that
    // synchronously inside the effect starts a second render immediately.
    queueMicrotask(() => void syncNow())

    const timer = setInterval(() => void syncNow(), INTERVAL_MS)
    const onWake = () => {
      if (document.visibilityState === 'visible') void syncNow()
    }
    document.addEventListener('visibilitychange', onWake)
    window.addEventListener('online', onWake)

    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onWake)
      window.removeEventListener('online', onWake)
    }
  }, [user, syncNow])

  const signIn = useCallback(async () => {
    setError(null)
    try {
      // Remembered so a reload keeps watching auth without a second sign-in.
      localStorage.setItem(SYNC_ENABLED_KEY, '1')
      setWantsSync(true)
      await signInWithGoogle()
    } catch (e) {
      const code = (e as { code?: string }).code
      if (code === 'auth/popup-closed-by-user') return
      setStatus('error')
      setError(e instanceof Error ? e.message : 'Sign-in failed.')
    }
  }, [])

  const signOut = useCallback(async () => {
    localStorage.removeItem(SYNC_ENABLED_KEY)
    await signOutOfGoogle()
    // The local copy is untouched: signing out must never look like data loss.
    setLastResult(null)
  }, [])

  return { user, status, lastResult, lastSyncedAt, error, signIn, signOut, syncNow }
}
