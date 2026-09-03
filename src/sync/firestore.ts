import type { Firestore } from 'firebase/firestore'
import { getFirestoreDb } from './firebase'
import type { RemoteRecord, RemoteStore } from './types'
import type { SyncedTable } from '../db/schema'
import type { Id } from '../db/ids'

/**
 * Firestore-backed remote, deliberately thin — the merge rules live in
 * `engine.ts`, where they can be tested without a network.
 *
 * Layout: `users/<uid>/records/<table>:<id>`. One flat collection per user
 * rather than a collection per table, so a pull is a single indexed query on
 * `updatedAt` instead of six.
 */
export class FirestoreRemote implements RemoteStore {
  private readonly uid: string
  private readonly fs: Firestore

  constructor(uid: string, fs: Firestore) {
    this.uid = uid
    this.fs = fs
  }

  private async records() {
    const { collection } = await import('firebase/firestore')
    return collection(this.fs, 'users', this.uid, 'records')
  }

  async pull(since: number): Promise<RemoteRecord[]> {
    const { getDocs, query, where } = await import('firebase/firestore')
    const snap = await getDocs(query(await this.records(), where('updatedAt', '>', since)))
    return snap.docs
      .map((d) => d.data() as RemoteRecord)
      .filter((r) => typeof r?.updatedAt === 'number' && typeof r?.id === 'string')
      .sort((a, b) => a.updatedAt - b.updatedAt)
  }

  async push(records: RemoteRecord[]): Promise<void> {
    const { doc, writeBatch } = await import('firebase/firestore')
    const col = await this.records()
    // Firestore caps a batch at 500 writes.
    for (let i = 0; i < records.length; i += 400) {
      const batch = writeBatch(this.fs)
      for (const r of records.slice(i, i + 400)) {
        batch.set(doc(col, key(r.table, r.id)), {
          table: r.table,
          id: r.id,
          updatedAt: r.updatedAt,
          deleted: r.deleted ?? false,
          // Firestore rejects undefined values, and a tombstone has no body.
          data: r.deleted ? null : stripUndefined(r.data ?? {}),
        })
      }
      await batch.commit()
    }
  }
}

/** Builds a remote bound to one user, loading the SDK on the way. */
export async function createFirestoreRemote(uid: string): Promise<FirestoreRemote> {
  return new FirestoreRemote(uid, await getFirestoreDb())
}

function key(table: SyncedTable, id: Id): string {
  return `${table}:${id}`
}

/** Optional fields are absent locally but must be explicit nulls in Firestore. */
function stripUndefined(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v
  }
  return out
}
