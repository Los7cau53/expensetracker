import type { Id } from './ids'
import { db, type SyncedTable } from './schema'

export interface UndoResult {
  txns: number
  fundIns: number
}

/**
 * Removes everything one import batch wrote — payments and fund inflows alike.
 *
 * Lives here rather than beside the Excel parser so that undoing an import
 * does not pull SheetJS (~450 kB) into the initial bundle.
 *
 * Projects, payees, categories and sources the import created are left in
 * place: they are harmless empty entries, and removing them could orphan
 * rows entered by hand since.
 */
export async function undoImport(batchId: Id): Promise<UndoResult> {
  return db.transaction(
    'rw',
    [db.txns, db.fundIns, db.importBatches, db.tombstones],
    async () => {
      // Ids are collected before the delete: sync needs to know which records
      // went, and afterwards there is nothing left to ask.
      const txnIds = (await db.txns.where('importBatchId').equals(batchId).primaryKeys()) as Id[]
      const fundInIds = (await db.fundIns
        .where('importBatchId')
        .equals(batchId)
        .primaryKeys()) as Id[]

      const txns = await db.txns.where('importBatchId').equals(batchId).delete()
      const fundIns = await db.fundIns.where('importBatchId').equals(batchId).delete()
      await db.importBatches.delete(batchId)

      const stamp = Date.now()
      const mark = (table: SyncedTable, ids: Id[]) =>
        db.tombstones.bulkPut(
          ids.map((recordId) => ({ id: `${table}:${recordId}`, table, recordId, deletedAt: stamp })),
        )
      await mark('txns', txnIds)
      await mark('fundIns', fundInIds)

      return { txns, fundIns }
    },
  )
}
