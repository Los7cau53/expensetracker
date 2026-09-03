/**
 * Dates are stored as 'YYYY-MM-DD' strings. They sort lexicographically,
 * index cleanly in IndexedDB, and carry no timezone to shift a payment
 * onto the wrong day.
 */

export type DateStr = string

export function todayStr(): DateStr {
  return toDateStr(new Date())
}

export function toDateStr(d: Date): DateStr {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export function isDateStr(s: unknown): boolean {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s)
}

/**
 * "12/03/2026" — day first, the Indian convention, and the same order the
 * date inputs show.
 *
 * Display only. Dates are stored as 'YYYY-MM-DD' throughout, which sorts
 * lexicographically, indexes cleanly and is unambiguous in a backup file;
 * formatting it away at the edges is the point of keeping the two separate.
 */
export function formatDate(s: DateStr): string {
  const [y, m, d] = s.split('-').map(Number)
  if (!y) return s
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d)}/${pad(m)}/${y}`
}

/** '2026-03' -> 'Mar 2026', for month grouping headers. */
export function formatMonth(ym: string): string {
  const [y, m] = ym.split('-').map(Number)
  if (!y) return ym
  return new Date(y, m - 1, 1).toLocaleDateString('en-IN', { month: 'short', year: 'numeric' })
}

export function monthOf(s: DateStr): string {
  return s.slice(0, 7)
}

/**
 * Axis-width month label: 'Feb' inside a single year, 'Feb 26' when the range
 * crosses one. Full 'Feb 2026' does not fit a seven-band axis on a phone.
 */
export function formatMonthShort(ym: string, includeYear = false): string {
  const [y, m] = ym.split('-').map(Number)
  if (!y) return ym
  const mon = new Date(y, m - 1, 1).toLocaleDateString('en-IN', { month: 'short' })
  return includeYear ? `${mon} ${String(y).slice(2)}` : mon
}

/**
 * Coerces spreadsheet date cells into 'YYYY-MM-DD'.
 * Handles Date objects (SheetJS cellDates), Excel serial numbers, and the
 * common typed formats. Returns null when ambiguous or unparseable so the
 * importer can reject the row instead of guessing a wrong date.
 *
 * `dayFirst` disambiguates 03/04/2026: true => 3 April (Indian convention).
 */
export function coerceToDateStr(raw: unknown, dayFirst = true): DateStr | null {
  if (raw === null || raw === undefined || raw === '') return null
  if (raw instanceof Date) {
    return Number.isNaN(raw.getTime()) ? null : toDateStr(raw)
  }

  // Excel serial date: days since 1899-12-30 (accounting for Excel's 1900 bug).
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || raw <= 0 || raw > 2958465) return null
    const ms = Math.round((raw - 25569) * 86400 * 1000)
    const d = new Date(ms)
    return Number.isNaN(d.getTime()) ? null : toDateStr(d)
  }

  const s = String(raw).trim()
  if (!s) return null

  if (isDateStr(s)) return s

  // d/m/yyyy, d-m-yy, d.m.yyyy
  const parts = s.match(/^(\d{1,4})[/\-.](\d{1,2})[/\-.](\d{2,4})$/)
  if (parts) {
    let [, a, b, c] = parts
    let day: number, month: number, year: number
    if (a.length === 4) {
      // yyyy-m-d
      year = Number(a); month = Number(b); day = Number(c)
    } else {
      day = dayFirst ? Number(a) : Number(b)
      month = dayFirst ? Number(b) : Number(a)
      year = Number(c)
      // An impossible month means our assumption was backwards.
      if (month > 12 && day <= 12) [day, month] = [month, day]
      if (year < 100) year += year < 70 ? 2000 : 1900
    }
    if (month < 1 || month > 12 || day < 1 || day > 31) return null
    const d = new Date(year, month - 1, day)
    // Rejects 31 Feb rather than letting JS roll it into March.
    if (d.getMonth() !== month - 1 || d.getDate() !== day) return null
    return toDateStr(d)
  }

  // "12 Mar 2026", "Mar 12, 2026" — but the platform parser is extremely
  // lenient (new Date('#111111') yields the year 111110), so only strings
  // that actually look like a date reach it, and the year must be plausible.
  const looksDateLike = /\d/.test(s) && (/[a-z]{3}/i.test(s) || /[\s/.,-]/.test(s))
  if (looksDateLike) {
    const parsed = new Date(s)
    if (!Number.isNaN(parsed.getTime())) {
      const year = parsed.getFullYear()
      if (year >= 1900 && year <= 2200) return toDateStr(parsed)
    }
  }

  return null
}

export function daysSince(ts: number): number {
  return Math.floor((Date.now() - ts) / 86400000)
}
