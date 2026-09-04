import { seedId } from './ids'
import { db, DEFAULT_CATEGORIES } from './schema'

/**
 * The change stamp a seeded default carries: zero, not `Date.now()`.
 *
 * Every device seeds the same defaults under the same derived ids, so a device
 * set up *after* another one renamed or deleted a cost head would otherwise
 * hold a locally-newer copy of that very record. Newest-write-wins would then
 * keep the freshly seeded default, discard the remote rename, ignore the remote
 * tombstone — and push the resurrected default back, undoing the work on the
 * device that did it.
 *
 * A stamp of zero loses every comparison, which is exactly right: a default
 * nobody has touched is a placeholder, and anything the remote has to say about
 * it wins. It also keeps `pendingChanges` from sending untouched defaults at
 * all, so they can never overwrite a tombstone. The first edit restamps the row
 * through the usual hook, and from then on it is ordinary data.
 */
export const SEED_STAMP = 0

/**
 * Populates the minimum a first-run user needs to record a payment
 * immediately: the standard cost heads, cash in hand, and one project.
 * Idempotent — safe to call on every app start.
 */
export async function seedIfEmpty(): Promise<void> {
  await db.transaction(
    'rw',
    [db.categories, db.sources, db.projects, db.settings],
    async () => {
      if ((await db.categories.count()) === 0) {
        await db.categories.bulkAdd(
          DEFAULT_CATEGORIES.map((name, i) => ({
            id: seedId('cat', name),
            name,
            sortOrder: i,
            archived: 0,
            updatedAt: SEED_STAMP,
          })) as never,
        )
      }

      if ((await db.sources.count()) === 0) {
        await db.sources.add({
          id: seedId('src', 'Cash in hand'),
          name: 'Cash in hand',
          type: 'cash',
          openingBalance: 0,
          archived: 0,
          createdAt: Date.now(),
          updatedAt: SEED_STAMP,
        } as never)
      }

      if ((await db.projects.count()) === 0) {
        await db.projects.add({
          id: seedId('proj', 'My first property'),
          name: 'My first property',
          status: 'active',
          createdAt: Date.now(),
          updatedAt: SEED_STAMP,
        } as never)
      }

      if (!(await db.settings.get('schemaVersion'))) {
        await db.settings.bulkPut([
          { key: 'schemaVersion', value: 1 },
          { key: 'currency', value: 'INR' },
          { key: 'lastBackupAt', value: null },
        ])
      }
    },
  )

  await demoteUntouchedSeeds()
}

/**
 * Drops the stamp on defaults that were seeded before seeding used
 * `SEED_STAMP`, so an already-installed device stops fighting the remote.
 *
 * Those rows carry the wall-clock of the moment that device first opened the
 * app, and on a device set up later that is newer than the remote's record of
 * every rename and deletion — the clash `SEED_STAMP` exists to prevent.
 *
 * A row only qualifies while it still looks *exactly* as seeding left it: same
 * derived id, same default name, nothing else changed. A default that has been
 * renamed, archived or edited is real work and keeps its stamp.
 */
export async function demoteUntouchedSeeds(): Promise<number> {
  const defaults = new Set(DEFAULT_CATEGORIES)
  let demoted = 0

  await db.transaction('rw', [db.categories, db.sources, db.projects], async () => {
    for (const c of await db.categories.toArray()) {
      if (c.updatedAt === SEED_STAMP) continue
      if (!defaults.has(c.name) || c.id !== seedId('cat', c.name)) continue
      if (c.archived) continue
      // Passing updatedAt explicitly stops the `updating` hook restamping it.
      await db.categories.update(c.id, { updatedAt: SEED_STAMP })
      demoted++
    }

    for (const s of await db.sources.toArray()) {
      if (s.updatedAt === SEED_STAMP) continue
      if (s.name !== 'Cash in hand' || s.id !== seedId('src', s.name)) continue
      if (s.type !== 'cash' || s.openingBalance !== 0 || s.archived) continue
      if (s.institution || s.notes) continue
      await db.sources.update(s.id, { updatedAt: SEED_STAMP })
      demoted++
    }

    for (const p of await db.projects.toArray()) {
      if (p.updatedAt === SEED_STAMP) continue
      if (p.name !== 'My first property' || p.id !== seedId('proj', p.name)) continue
      if (p.status !== 'active' || p.address || p.budget) continue
      await db.projects.update(p.id, { updatedAt: SEED_STAMP })
      demoted++
    }
  })

  return demoted
}

/**
 * Asks the browser to make storage persistent. Without this, browsers may
 * evict IndexedDB under storage pressure — and here that is the only copy
 * of the data. Best-effort: Safari ignores it, hence the backup nag.
 */
export async function requestPersistentStorage(): Promise<boolean> {
  try {
    if (!navigator.storage?.persist) return false
    if (await navigator.storage.persisted()) return true
    return await navigator.storage.persist()
  } catch {
    return false
  }
}
