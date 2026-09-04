import { db, SYNCED_TABLES, type SyncedTable } from '../db/schema'
import type { Id } from '../db/ids'
import { SEED_STAMP } from '../db/seed'
import { EMPTY_RESULT, type RemoteRecord, type RemoteStore, type SyncResult } from './types'

const PUSHED_KEY = 'syncPushedThrough'
const PULLED_KEY = 'syncPulledThrough'

async function cursor(key: string): Promise<number> {
  const row = await db.settings.get(key)
  return typeof row?.value === 'number' ? row.value : 0
}

function table(name: SyncedTable) {
  return db[name] as unknown as {
    toArray: () => Promise<Record<string, unknown>[]>
    get: (id: Id) => Promise<Record<string, unknown> | undefined>
    bulkPut: (rows: unknown[]) => Promise<unknown>
    delete: (id: Id) => Promise<void>
  }
}

/**
 * Collects local changes the remote has not seen.
 *
 * Selection is by the record's own `updatedAt` rather than a dirty flag: the
 * stamp is written by a Dexie hook on every insert and update, so nothing can
 * be changed without becoming eligible, however it was changed.
 *
 * Untouched seeded defaults sit at `SEED_STAMP` and so are never eligible.
 * That is deliberate: sending one would overwrite the remote's tombstone for a
 * default the user deleted elsewhere, and put it back on every device.
 */
export async function pendingChanges(since: number): Promise<RemoteRecord[]> {
  const out: RemoteRecord[] = []

  for (const name of SYNCED_TABLES) {
    for (const row of await table(name).toArray()) {
      const updatedAt = Number(row.updatedAt ?? row.createdAt ?? 0)
      if (updatedAt > since) {
        out.push({ table: name, id: row.id as Id, updatedAt, data: row })
      }
    }
  }

  for (const t of await db.tombstones.toArray()) {
    if (t.deletedAt > since) {
      out.push({ table: t.table, id: t.recordId, updatedAt: t.deletedAt, deleted: true })
    }
  }

  return out.sort((a, b) => a.updatedAt - b.updatedAt)
}

/**
 * Applies remote records, newest-write-wins per record.
 *
 * Per record, not per database: two devices editing *different* payments both
 * keep their work, and only a genuine same-record clash is decided by the
 * stamp. That is the whole reason this is not a whole-file sync.
 */
export async function applyRemote(records: RemoteRecord[]): Promise<{
  applied: number
  skippedStale: number
  deletedLocally: number
}> {
  let applied = 0
  let skippedStale = 0
  let deletedLocally = 0

  for (const r of records) {
    if (!SYNCED_TABLES.includes(r.table)) continue
    const t = table(r.table)
    const local = await t.get(r.id)
    const localStamp = Number(local?.updatedAt ?? local?.createdAt ?? 0)

    if (r.deleted) {
      if (!local) continue
      // A local edit made after the delete wins: the reader touched the record
      // more recently than whoever removed it, so it comes back rather than
      // vanishing under them.
      if (localStamp > r.updatedAt) {
        skippedStale++
        continue
      }
      await t.delete(r.id)
      deletedLocally++
      continue
    }

    if (!r.data) continue
    if (local && localStamp >= r.updatedAt) {
      skippedStale++
      continue
    }

    // The remote stamp is written verbatim. Letting the local clock restamp it
    // would make the record look locally-newer and push straight back, and the
    // two devices would trade the same row forever.
    await t.bulkPut([{ ...r.data, id: r.id, updatedAt: r.updatedAt }])
    applied++
  }

  return { applied, skippedStale, deletedLocally }
}

/**
 * Promotes seeded defaults the remote has never heard of into real records.
 *
 * Defaults are held back from every push (see `pendingChanges`), which is what
 * stops a late device resurrecting deleted ones — but it would also leave the
 * remote with no copy of them at all, so a payment filed under "Masonry" would
 * depend on every device seeding an identical list forever. On the one pass
 * that reads the whole remote, its opinion of each default is known: whatever
 * it did not mention, it has never seen, and this device adopts.
 *
 * A default the remote *did* mention was already resolved by `applyRemote` —
 * renamed here, or deleted here — so it is no longer sitting at `SEED_STAMP`
 * and is left alone.
 */
async function adoptUnknownSeeds(incoming: RemoteRecord[]): Promise<RemoteRecord[]> {
  const known = new Set(incoming.map((r) => `${r.table}:${r.id}`))
  const updatedAt = Date.now()
  const adopted: RemoteRecord[] = []

  for (const name of SYNCED_TABLES) {
    for (const row of await table(name).toArray()) {
      const id = row.id as Id
      if (Number(row.updatedAt ?? 0) !== SEED_STAMP) continue
      if (known.has(`${name}:${id}`)) continue
      adopted.push({ table: name, id, updatedAt, data: { ...row, updatedAt } })
    }
  }

  for (const r of adopted) await table(r.table).bulkPut([r.data])
  return adopted
}

/**
 * One push-then-pull pass.
 *
 * Push first so a fresh device's work reaches the remote before anything can
 * be resolved against it.
 */
export async function syncOnce(remote: RemoteStore): Promise<SyncResult> {
  const ranAt = Date.now()
  const pushedThrough = await cursor(PUSHED_KEY)
  const pulledThrough = await cursor(PULLED_KEY)

  const outgoing = await pendingChanges(pushedThrough)
  if (outgoing.length > 0) await remote.push(outgoing)

  const incoming = await remote.pull(pulledThrough)
  const { applied, skippedStale, deletedLocally } = await applyRemote(incoming)

  // Only on a pass that pulled from the beginning of time, since only then is
  // `incoming` the remote's whole story rather than a recent slice of it.
  if (pulledThrough === 0) {
    const adopted = await adoptUnknownSeeds(incoming)
    if (adopted.length > 0) {
      // Sent in this pass rather than left for the next one, so the cursor
      // below covers them and they are not sent twice.
      await remote.push(adopted)
      outgoing.push(...adopted)
    }
  }

  // Advanced only after the work succeeded, so a failure mid-way is retried
  // rather than skipped. Cursors track record stamps, not wall-clock now, so a
  // record written while this ran is not stepped over.
  const highestPushed = outgoing.reduce((m, r) => Math.max(m, r.updatedAt), pushedThrough)
  const highestPulled = incoming.reduce((m, r) => Math.max(m, r.updatedAt), pulledThrough)
  await db.settings.bulkPut([
    { key: PUSHED_KEY, value: highestPushed },
    { key: PULLED_KEY, value: highestPulled },
  ])

  return {
    ...EMPTY_RESULT,
    pushed: outgoing.length,
    pulled: incoming.length,
    applied,
    skippedStale,
    deletedLocally,
    ranAt,
  }
}

/** Forgets what has been synced, so the next pass sends and receives everything. */
export async function resetSyncCursors(): Promise<void> {
  await db.settings.bulkPut([
    { key: PUSHED_KEY, value: 0 },
    { key: PULLED_KEY, value: 0 },
  ])
}

export async function syncCursors(): Promise<{ pushedThrough: number; pulledThrough: number }> {
  return { pushedThrough: await cursor(PUSHED_KEY), pulledThrough: await cursor(PULLED_KEY) }
}
