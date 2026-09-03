import type { Id } from './ids'
import {
  db,
  type Category,
  type Payee,
  type PayeeRole,
  type Project,
  type ProjectStatus,
  type Source,
  type SourceType,
} from './schema'
import type { Paise } from '../lib/money'

export interface SourceUsage {
  txnCount: number
  fundInCount: number
  /** True when deleting would orphan rows, so merge or archive is the answer. */
  inUse: boolean
}

export async function sourceUsage(sourceId: Id): Promise<SourceUsage> {
  const [txnCount, fundInCount] = await Promise.all([
    db.txns.where('sourceId').equals(sourceId).count(),
    db.fundIns.where('sourceId').equals(sourceId).count(),
  ])
  return { txnCount, fundInCount, inUse: txnCount + fundInCount > 0 }
}

export interface SourceEdits {
  name: string
  type: SourceType
  institution?: string
  openingBalance: Paise
  notes?: string
}

export async function updateSource(sourceId: Id, edits: SourceEdits): Promise<void> {
  const name = edits.name.trim()
  if (!name) throw new Error('A source needs a name.')

  const norm = (v: string) => v.trim().toLowerCase()
  const current = await db.sources.get(sourceId)
  if (!current) throw new Error('That source no longer exists.')

  // Only guard against a *new* collision. An import can leave two spellings of
  // one account ("sbi 4471" and "SBI 4471"); checking unconditionally would
  // then block fixing either one's type until it was also renamed.
  if (norm(name) !== norm(current.name)) {
    const clash = (await db.sources.toArray()).find(
      (s) => s.id !== sourceId && norm(s.name) === norm(name),
    )
    if (clash) throw new Error(`"${clash.name}" already exists. Merge into it instead.`)
  }

  await db.sources.update(sourceId, {
    name,
    type: edits.type,
    institution: edits.institution?.trim() || undefined,
    openingBalance: edits.openingBalance,
    notes: edits.notes?.trim() || undefined,
  })
}

/**
 * Archiving hides a source from the Add screen's picker but leaves every
 * historical row pointing at it, so past reports stay intact. This is the
 * right move for an account you have stopped using.
 */
export async function setSourceArchived(sourceId: Id, archived: boolean): Promise<void> {
  await db.sources.update(sourceId, { archived: archived ? 1 : 0 })
}

/**
 * Deletes a source outright. Refuses while anything still points at it —
 * a dangling sourceId would leave payments that belong to no account and
 * quietly break every balance.
 */
export async function deleteSource(sourceId: Id): Promise<void> {
  const usage = await sourceUsage(sourceId)
  if (usage.inUse) {
    throw new Error(
      `${usage.txnCount} payments and ${usage.fundInCount} inflows still use this source. ` +
        'Merge it into another source, or archive it instead.',
    )
  }
  if ((await db.sources.count()) <= 1) {
    throw new Error('This is your only source. Add another before deleting this one.')
  }
  await db.sources.delete(sourceId)
}

export interface MergeResult {
  movedTxns: number
  movedFundIns: number
  openingBalanceAdded: Paise
}

/**
 * Moves everything from one source onto another and deletes the empty one.
 *
 * The importer matches sources by name, so a sheet spelling an account two
 * ways ("sbi 4471" and "SBI 4471") produces two entries for one real account.
 * Opening balances are added together, so the merged source's balance equals
 * the sum of the two it replaces.
 */
export async function mergeSources(fromId: Id, intoId: Id): Promise<MergeResult> {
  if (fromId === intoId) throw new Error('Pick a different source to merge into.')

  return db.transaction('rw', [db.sources, db.txns, db.fundIns], async () => {
    const from = await db.sources.get(fromId)
    const into = await db.sources.get(intoId)
    if (!from || !into) throw new Error('One of those sources no longer exists.')

    const movedTxns = await db.txns.where('sourceId').equals(fromId).modify({ sourceId: intoId })
    const movedFundIns = await db.fundIns
      .where('sourceId')
      .equals(fromId)
      .modify({ sourceId: intoId })

    await db.sources.update(intoId, {
      openingBalance: into.openingBalance + from.openingBalance,
    })
    await db.sources.delete(fromId)

    return { movedTxns, movedFundIns, openingBalanceAdded: from.openingBalance }
  })
}

/** Sources a given one may be merged into. */
export async function mergeTargets(sourceId: Id): Promise<Source[]> {
  return (await db.sources.toArray())
    .filter((s) => s.id !== sourceId)
    .sort((a, b) => a.name.localeCompare(b.name))
}

// ---------------------------------------------------------------------------
// Payees, cost heads and properties.
//
// The same three operations as sources, and for the same reason: an import
// matches these by name, so a sheet that spells one recipient several ways
// leaves several entries for one real person. Only merging puts the history
// back together.
//
// Delete always refuses while anything references the entity. `categoryId` and
// `projectId` are non-nullable on a transaction, so a dangling id would leave
// rows that cannot be rendered; `payeeId` is nullable, but silently unassigning
// a person's payments loses the very fact the ledger exists to record.
// ---------------------------------------------------------------------------

export interface Usage {
  txnCount: number
  fundInCount: number
  inUse: boolean
}

const usage = (txnCount: number, fundInCount = 0): Usage => ({
  txnCount,
  fundInCount,
  inUse: txnCount + fundInCount > 0,
})

async function assertNameFree(
  table: 'payees' | 'categories' | 'projects',
  id: Id,
  name: string,
): Promise<void> {
  const norm = (v: string) => v.trim().toLowerCase()
  const rows = await db[table].toArray()
  const current = rows.find((r) => r.id === id)
  if (!current) throw new Error('That entry no longer exists.')

  // Only guard a genuine rename. An import can leave two spellings already
  // colliding; checking unconditionally would lock both out of every edit.
  if (norm(name) === norm(current.name)) return
  const clash = rows.find((r) => r.id !== id && norm(r.name) === norm(name))
  if (clash) throw new Error(`"${clash.name}" already exists. Merge into it instead.`)
}

// --- payees ---------------------------------------------------------------

export async function payeeUsage(payeeId: Id): Promise<Usage> {
  return usage(await db.txns.where('payeeId').equals(payeeId).count())
}

export async function updatePayee(
  payeeId: Id,
  edits: { name: string; role: PayeeRole; phone?: string; notes?: string },
): Promise<void> {
  const name = edits.name.trim()
  if (!name) throw new Error('A payee needs a name.')
  await assertNameFree('payees', payeeId, name)
  await db.payees.update(payeeId, {
    name,
    role: edits.role,
    phone: edits.phone?.trim() || undefined,
    notes: edits.notes?.trim() || undefined,
  })
}

export async function setPayeeArchived(payeeId: Id, archived: boolean): Promise<void> {
  await db.payees.update(payeeId, { archived: archived ? 1 : 0 })
}

export async function deletePayee(payeeId: Id): Promise<void> {
  const u = await payeeUsage(payeeId)
  if (u.inUse) {
    throw new Error(
      `${u.txnCount} payments are recorded against this payee. ` +
        'Merge them into another payee, or archive this one instead.',
    )
  }
  await db.payees.delete(payeeId)
}

export async function mergePayees(fromId: Id, intoId: Id): Promise<{ movedTxns: number }> {
  if (fromId === intoId) throw new Error('Pick a different payee to merge into.')
  return db.transaction('rw', [db.payees, db.txns], async () => {
    const from = await db.payees.get(fromId)
    const into = await db.payees.get(intoId)
    if (!from || !into) throw new Error('One of those payees no longer exists.')
    const movedTxns = await db.txns.where('payeeId').equals(fromId).modify({ payeeId: intoId })
    await db.payees.delete(fromId)
    return { movedTxns }
  })
}

export async function payeeMergeTargets(payeeId: Id): Promise<Payee[]> {
  return (await db.payees.toArray())
    .filter((p) => p.id !== payeeId)
    .sort((a, b) => a.name.localeCompare(b.name))
}

// --- cost heads -----------------------------------------------------------

export async function categoryUsage(categoryId: Id): Promise<Usage> {
  return usage(await db.txns.where('categoryId').equals(categoryId).count())
}

export async function updateCategory(categoryId: Id, name: string): Promise<void> {
  const trimmed = name.trim()
  if (!trimmed) throw new Error('A cost head needs a name.')
  await assertNameFree('categories', categoryId, trimmed)
  await db.categories.update(categoryId, { name: trimmed })
}

export async function setCategoryArchived(categoryId: Id, archived: boolean): Promise<void> {
  await db.categories.update(categoryId, { archived: archived ? 1 : 0 })
}

export async function deleteCategory(categoryId: Id): Promise<void> {
  const u = await categoryUsage(categoryId)
  if (u.inUse) {
    throw new Error(
      `${u.txnCount} payments use this cost head. Merge it into another one, or archive it.`,
    )
  }
  if ((await db.categories.count()) <= 1) {
    throw new Error('This is your only cost head. Add another before deleting this one.')
  }
  await db.categories.delete(categoryId)
}

export async function mergeCategories(
  fromId: Id,
  intoId: Id,
): Promise<{ movedTxns: number }> {
  if (fromId === intoId) throw new Error('Pick a different cost head to merge into.')
  return db.transaction('rw', [db.categories, db.txns], async () => {
    const from = await db.categories.get(fromId)
    const into = await db.categories.get(intoId)
    if (!from || !into) throw new Error('One of those cost heads no longer exists.')
    const movedTxns = await db.txns.where('categoryId').equals(fromId).modify({ categoryId: intoId })
    await db.categories.delete(fromId)
    return { movedTxns }
  })
}

export async function categoryMergeTargets(categoryId: Id): Promise<Category[]> {
  return (await db.categories.toArray())
    .filter((c) => c.id !== categoryId)
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** Adds a cost head, placed after the existing ones. */
export async function addCategory(name: string): Promise<Id> {
  const trimmed = name.trim()
  if (!trimmed) throw new Error('A cost head needs a name.')
  const norm = (v: string) => v.trim().toLowerCase()
  if ((await db.categories.toArray()).some((c) => norm(c.name) === norm(trimmed))) {
    throw new Error(`"${trimmed}" already exists.`)
  }
  const sortOrder = (await db.categories.count()) + 1000
  return (await db.categories.add({ name: trimmed, sortOrder, archived: 0 } as never)) as string
}

// --- properties -----------------------------------------------------------

export async function projectUsage(projectId: Id): Promise<Usage> {
  const [txnCount, fundInCount] = await Promise.all([
    db.txns.where('projectId').equals(projectId).count(),
    db.fundIns.where('projectId').equals(projectId).count(),
  ])
  return usage(txnCount, fundInCount)
}

export async function updateProject(
  projectId: Id,
  edits: { name: string; address?: string; status: ProjectStatus; budget?: Paise },
): Promise<void> {
  const name = edits.name.trim()
  if (!name) throw new Error('A property needs a name.')
  await assertNameFree('projects', projectId, name)
  await db.projects.update(projectId, {
    name,
    address: edits.address?.trim() || undefined,
    status: edits.status,
    budget: edits.budget && edits.budget > 0 ? edits.budget : undefined,
  })
}

export async function deleteProject(projectId: Id): Promise<void> {
  const u = await projectUsage(projectId)
  if (u.inUse) {
    throw new Error(
      `${u.txnCount} payments and ${u.fundInCount} inflows belong to this property. ` +
        'Merge it into another property first.',
    )
  }
  if ((await db.projects.count()) <= 1) {
    throw new Error('This is your only property. Add another before deleting this one.')
  }
  await db.projects.delete(projectId)
}

export async function mergeProjects(
  fromId: Id,
  intoId: Id,
): Promise<{ movedTxns: number; movedFundIns: number; budgetAdded: Paise }> {
  if (fromId === intoId) throw new Error('Pick a different property to merge into.')
  return db.transaction('rw', [db.projects, db.txns, db.fundIns], async () => {
    const from = await db.projects.get(fromId)
    const into = await db.projects.get(intoId)
    if (!from || !into) throw new Error('One of those properties no longer exists.')

    const movedTxns = await db.txns.where('projectId').equals(fromId).modify({ projectId: intoId })
    const movedFundIns = await db.fundIns
      .where('projectId')
      .equals(fromId)
      .modify({ projectId: intoId })

    // Budgets add up, so the merged property is not instantly over budget.
    const budgetAdded = from.budget ?? 0
    if (budgetAdded > 0) {
      await db.projects.update(intoId, { budget: (into.budget ?? 0) + budgetAdded })
    }
    await db.projects.delete(fromId)
    return { movedTxns, movedFundIns, budgetAdded }
  })
}

export async function projectMergeTargets(projectId: Id): Promise<Project[]> {
  return (await db.projects.toArray())
    .filter((p) => p.id !== projectId)
    .sort((a, b) => a.name.localeCompare(b.name))
}
