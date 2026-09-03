import { seedId } from './ids'
import { db, DEFAULT_CATEGORIES } from './schema'

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
        } as never)
      }

      if ((await db.projects.count()) === 0) {
        await db.projects.add({
          id: seedId('proj', 'My first property'),
          name: 'My first property',
          status: 'active',
          createdAt: Date.now(),
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
