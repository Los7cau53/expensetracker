import { db } from './schema'

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
export async function undoImport(batchId: number): Promise<UndoResult> {
  return db.transaction('rw', [db.txns, db.fundIns, db.importBatches], async () => {
    const txns = await db.txns.where('importBatchId').equals(batchId).delete()
    const fundIns = await db.fundIns.where('importBatchId').equals(batchId).delete()
    await db.importBatches.delete(batchId)
    return { txns, fundIns }
  })
}
