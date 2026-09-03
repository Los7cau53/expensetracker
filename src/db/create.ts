import { db } from './schema'
import type { Id } from './ids'
import { addCategory } from './manage'
import { guessPayeeRole, guessSourceType } from '../lib/infer'

/**
 * Creating a dimension from wherever you happen to be.
 *
 * Recording a payment used to mean leaving the screen to add the cost head,
 * the source or the property first, then coming back and starting over. At a
 * site, mid-payment, that is the friction that sends people back to a
 * notebook. These are shared by the Add screen and the ledger's row editor so
 * the two cannot drift.
 *
 * Everything is inferred from the name — a payee's role, a source's type — the
 * same way the Excel importer infers them, and is correctable later in
 * Settings.
 */

export async function createPayeeByName(name: string): Promise<Id> {
  return (await db.payees.add({
    name: name.trim(),
    role: guessPayeeRole(name),
    archived: 0,
  } as never)) as Id
}

export async function createCategoryByName(name: string): Promise<Id> {
  return addCategory(name)
}

export async function createSourceByName(name: string): Promise<Id> {
  return (await db.sources.add({
    name: name.trim(),
    type: guessSourceType(name),
    openingBalance: 0,
    archived: 0,
  } as never)) as Id
}

export async function createProjectByName(name: string): Promise<Id> {
  return (await db.projects.add({
    name: name.trim(),
    status: 'active',
  } as never)) as Id
}

/** What was guessed, so the reader can be told rather than surprised later. */
export function guessedSourceTypeFor(name: string): string {
  return guessSourceType(name)
}
