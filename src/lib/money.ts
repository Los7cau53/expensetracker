/**
 * Money is stored as an integer number of paise, never a float.
 * Floating point rupees silently break balance reconciliation
 * (0.1 + 0.2 !== 0.3), and this app's core claim is that a source
 * balance equals opening + inflows - outflows exactly.
 */

export type Paise = number

const inr = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

const inrCompact = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
})

/** "₹1,23,456.50" */
export function formatPaise(p: Paise): string {
  return inr.format(p / 100)
}

/** "₹1,23,457" — for dashboards where paise are noise. */
export function formatPaiseShort(p: Paise): string {
  return inrCompact.format(Math.round(p / 100))
}

/**
 * Parses user and spreadsheet input into paise.
 * Accepts "1,23,456.50", "₹ 1234", "1234.5", "(500)" as negative, "1.2e3".
 * Returns null when there is no parseable number, so callers can reject a row
 * rather than silently importing a zero.
 */
export function parseAmountToPaise(raw: unknown): Paise | null {
  if (raw === null || raw === undefined) return null

  // Excel numeric cells arrive as JS numbers already in rupees.
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) return null
    return Math.round(raw * 100)
  }

  let s = String(raw).trim()
  if (!s) return null

  // Accounting-style negatives: (500) means -500.
  let negative = false
  if (/^\(.*\)$/.test(s)) {
    negative = true
    s = s.slice(1, -1)
  }

  // Strip currency symbols, spaces and grouping separators (Indian grouping is
  // irregular — 1,23,456 — so we cannot rely on fixed 3-digit groups).
  s = s.replace(/[₹$,\s ]/g, '')
  if (s.startsWith('-')) {
    negative = !negative
    s = s.slice(1)
  }
  if (s.startsWith('+')) s = s.slice(1)

  if (!/^\d*\.?\d*(?:[eE][+-]?\d+)?$/.test(s) || s === '' || s === '.') return null

  const n = Number(s)
  if (!Number.isFinite(n)) return null

  const paise = Math.round(n * 100)
  return negative ? -paise : paise
}

/** Digits typed into the amount field -> paise, for the keypad-style input. */
export function rupeeStringToPaise(s: string): Paise {
  return parseAmountToPaise(s) ?? 0
}

/**
 * Axis-tick and stat-tile scale, in the Indian idiom: thousands, lakh, crore.
 * "₹1.94L" beats "₹1,93,250.50" on a 390px-wide axis, and a reader here thinks
 * in lakhs long before they think in millions.
 */
export function formatPaiseCompact(p: Paise): string {
  const rupees = p / 100
  const sign = rupees < 0 ? '-' : ''
  const n = Math.abs(rupees)

  if (n === 0) return '₹0'
  if (n < 1_000) return `${sign}₹${trim(n, 0)}`
  if (n < 1_00_000) return `${sign}₹${trim(n / 1_000, 1)}K`
  if (n < 1_00_00_000) return `${sign}₹${trim(n / 1_00_000, 2)}L`
  return `${sign}₹${trim(n / 1_00_00_000, 2)}Cr`
}

function trim(n: number, maxDp: number): string {
  const fixed = n.toFixed(maxDp)
  // Drop a trailing ".0" / ".00" so ticks read 2L rather than 2.00L — but only
  // past the decimal point, or 450 would be trimmed to 45.
  if (!fixed.includes('.')) return fixed
  return fixed.replace(/\.?0+$/, '')
}
