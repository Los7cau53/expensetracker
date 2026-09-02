import type { PayeeRole, SourceType } from '../db/schema'

/**
 * Name-based classification, shared by manual entry and the Excel importer
 * so both paths tag a payee or source the same way. Lives apart from the
 * importer to keep SheetJS out of the initial bundle.
 */

export function guessPayeeRole(name: string): PayeeRole {
  const s = name.toLowerCase()
  if (/mestri|mesthri|mistri|mason/.test(s)) return 'mestri'
  if (/electric|wiring|current/.test(s)) return 'electrician'
  if (/plumb|sanitary/.test(s)) return 'plumber'
  if (/carpent|wood/.test(s)) return 'carpenter'
  if (/paint/.test(s)) return 'painter'
  if (/labour|labor|coolie|worker|stone\s*break/.test(s)) return 'labour'
  if (/cement|steel|sand|brick|tile|hardware|supplier|traders|stores|agencies|depot/.test(s))
    return 'material'
  if (/jcb|crane|mixer|rental|hire|tractor|lorry|tipper|bore/.test(s)) return 'machinery'
  if (
    /panchayat|municipal|corporation|gram|govt|government|tax|permission|permit|approval|dtcp|hmda/.test(s)
  )
    return 'govt'
  if (/engineer|architect|contractor|consultant|surveyor|geologist/.test(s)) return 'professional'
  return 'other'
}

export function guessSourceType(name: string): SourceType {
  const s = name.toLowerCase()
  if (/cash|atm/.test(s)) return 'cash'
  if (/gpay|g pay|phonepe|paytm|upi|online|net\s*banking/.test(s)) return 'upi'
  if (/loan|emi/.test(s)) return 'loan'
  if (/card|credit|debit/.test(s)) return 'card'
  return 'bank'
}
