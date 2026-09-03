import { coerceToDateStr, toDateStr, type DateStr } from './date'
import { parseAmountToPaise, type Paise } from './money'

/**
 * Reads a Google Pay receipt, from its filename and from OCR of the image.
 *
 * Two independent sources, because they fail in different places. A file
 * shared out of Google Pay is named
 *
 *   1787832753 - 16000.00 To prakash Raj Raj on Google Pay.png
 *
 * which carries the epoch timestamp, the amount and the payee exactly — no OCR
 * needed, no guessing. What it never carries is the bank the money left and
 * the UPI reference, and those only exist inside the image. A plain screenshot
 * taken with the volume buttons carries nothing in its name, so OCR is also
 * the fallback for everything.
 */

export type Direction = 'out' | 'in'
export type PaymentStatus = 'completed' | 'failed' | 'pending' | 'unknown'

export interface ReceiptFields {
  amount?: Paise
  date?: DateStr
  /** Local time as HH:MM, for the note — the ledger itself is date-only. */
  time?: string
  payee?: string
  /** The bank account holder name on the recipient's side, when shown. */
  payeeAccountName?: string
  bank?: string
  bankLast4?: string
  reference?: string
  direction?: Direction
  status?: PaymentStatus
  /** Which signals produced each field, so the UI can say where it came from. */
  from: Partial<Record<keyof Omit<ReceiptFields, 'from'>, 'filename' | 'ocr'>>
}

// --- filename -------------------------------------------------------------

/**
 * `1787832753 - 16000.00 To prakash Raj Raj on Google Pay.png`
 *   epoch seconds ─┘   amount ─┘  direction ─┘ payee ─┘
 */
const FILENAME = /^(\d{9,13})\s*-\s*([\d.]+)\s+(to|from)\s+(.+?)\s+on\s+Google\s*Pay/i

export function parseGpayFilename(filename: string): ReceiptFields {
  const out: ReceiptFields = { from: {} }
  const m = filename.match(FILENAME)
  if (!m) return out

  const [, stamp, amount, dir, payee] = m

  const paise = parseAmountToPaise(amount)
  if (paise !== null && paise > 0) {
    out.amount = paise
    out.from.amount = 'filename'
  }

  // 10 digits is seconds, 13 is milliseconds.
  const ms = stamp.length >= 13 ? Number(stamp) : Number(stamp) * 1000
  const d = new Date(ms)
  if (!Number.isNaN(d.getTime()) && d.getFullYear() > 2000 && d.getFullYear() < 2200) {
    out.date = toDateStr(d)
    out.from.date = 'filename'
    out.time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
    out.from.time = 'filename'
  }

  out.direction = dir.toLowerCase() === 'from' ? 'in' : 'out'
  out.from.direction = 'filename'

  const name = payee.trim()
  if (name) {
    out.payee = name
    out.from.payee = 'filename'
  }

  return out
}

// --- OCR text -------------------------------------------------------------

/**
 * OCR reads `0` in the bank line as `o` (`ICICI Bank 0763` becomes
 * `(ciciBanko763`), so digits are recovered by mapping the usual confusions
 * back before matching.
 */
function digitsFrom(s: string): string {
  return s.replace(/[oO]/g, '0').replace(/[lI|]/g, '1').replace(/[sS]/g, '5')
}

const STATUS: [RegExp, PaymentStatus][] = [
  [/\bcompleted\b|\bsuccess(ful)?\b|\bpaid\b/i, 'completed'],
  [/\bfail(ed|ure)?\b|\bdeclined\b|\bunsuccessful\b/i, 'failed'],
  [/\bpending\b|\bprocessing\b|\bin\s*progress\b/i, 'pending'],
]

export function parseGpayText(text: string): ReceiptFields {
  const out: ReceiptFields = { from: {} }
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)

  const mark = <K extends keyof Omit<ReceiptFields, 'from'>>(k: K, v: ReceiptFields[K]) => {
    if (v !== undefined && out[k] === undefined) {
      out[k] = v
      out.from[k] = 'ocr'
    }
  }

  for (const [re, status] of STATUS) {
    if (re.test(text)) {
      mark('status', status)
      break
    }
  }
  if (out.status === undefined) mark('status', 'unknown')

  let chipBankName: string | undefined

  for (const line of lines) {
    // "To prakash Raj Raj" / "Paid to X" — the contact's display name. The
    // colon form ("To: T RAJU") is the bank account name, kept separately.
    const to = line.match(/^(?:paid\s+to|to)\s+(?!:)(.{2,60})$/i)
    if (to && !/transaction|google\s*pay|^:/i.test(to[1])) mark('payee', to[1].trim())

    const from = line.match(/^(?:received\s+from|from)\s+(?!:)(.{2,60})$/i)
    if (from && !/google\s*pay/i.test(from[1])) {
      mark('payee', from[1].trim())
      mark('direction', 'in')
    }

    const toAcct = line.match(/^to:\s*(.{2,60})$/i)
    if (toAcct) mark('payeeAccountName', toAcct[1].trim())

    // "From: RATNA TEJA CH (ICICI Bank)" — the cleanest source of the bank.
    const fromAcct = line.match(/^from:\s*(.*?)\s*\(([^)]+)\)\s*$/i)
    if (fromAcct) {
      mark('bank', fromAcct[2].trim())
      mark('direction', 'out')
    }

    // The header chip: "ICICI Bank 0763", mangled by OCR to "(ciciBanko763".
    // Only the four digits are trusted from it — the leading letters are the
    // part OCR loses, and the digit recovery below would corrupt a real name
    // like "Bank of Baroda" into "Bank 0f Bar0da".
    const last4 = digitsFrom(line).match(/bank\s*(\d{4})\b/i)
    if (last4) mark('bankLast4', last4[1])

    // Held as a fallback and applied only after the loop, so a clean
    // "From: NAME (ICICI Bank)" anywhere below always beats it.
    const chipName = line.match(/([A-Za-z][A-Za-z ]{1,24}?)\s*bank(?:\b|\s*\d)/i)
    if (chipName && !/^from|^to/i.test(line) && !chipBankName) {
      chipBankName = `${chipName[1].trim()} Bank`
    }

    // "27 Aug 2026, 5:42pm"
    const dt = line.match(/(\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4})(?:,\s*(\d{1,2}):(\d{2})\s*([ap]m)?)?/i)
    if (dt) {
      const d = coerceToDateStr(dt[1])
      if (d) mark('date', d)
      if (dt[2]) {
        let h = Number(dt[2])
        const pm = dt[4]?.toLowerCase() === 'pm'
        if (pm && h < 12) h += 12
        if (!pm && dt[4] && h === 12) h = 0
        mark('time', `${String(h).padStart(2, '0')}:${dt[3]}`)
      }
    }
  }

  if (out.bank === undefined && chipBankName) mark('bank', chipBankName)
  mark('amount', pickAmount(lines) ?? undefined)
  mark('reference', pickReference(text) ?? undefined)
  if (out.direction === undefined) mark('direction', 'out')

  return out
}

/**
 * The amount, told apart from the phone number and the transaction IDs that
 * share the screen. Grouped or decimal-bearing numbers are the strong signal:
 * "16,000" is an amount, "26202" is the tail of a masked phone number and
 * happens to be the larger of the two.
 */
function pickAmount(lines: string[]): Paise | null {
  const candidates: Paise[] = []

  for (const line of lines) {
    if (/\+91|transaction|@|upi\b/i.test(line)) continue

    const m = line.match(/^[₹?%*\s]*([\d][\d,]*(?:\.\d{1,2})?)\s*$/)
    if (!m) continue

    const raw = m[1]
    const grouped = raw.includes(',')
    const decimal = raw.includes('.')
    const hadSymbol = /₹/.test(line)
    // A bare run of digits is far more likely an id or a masked number.
    if (!grouped && !decimal && !hadSymbol) continue
    // 12-digit UPI ids can carry commas after OCR; amounts here do not run
    // past a crore.
    const paise = parseAmountToPaise(raw)
    if (paise === null || paise <= 0 || paise > 100_00_00_000_00) continue
    candidates.push(paise)
  }

  if (candidates.length === 0) return null
  // Google Pay puts the amount in the largest type near the top; where several
  // survive, the biggest is the total rather than a fee or a running balance.
  return Math.max(...candidates)
}

function pickReference(text: string): string | null {
  const upi = text.match(/UPI\s*transaction\s*ID\s*[:\s]*([A-Za-z0-9]{8,25})/i)
  if (upi) return upi[1]
  const google = text.match(/Google\s*transaction\s*ID\s*[:\s]*([A-Za-z0-9]{8,25})/i)
  if (google) return google[1]
  // A lone 12-digit run is the UPI reference's usual shape.
  const bare = text.match(/(?:^|\s)(\d{12})(?:\s|$)/)
  return bare ? bare[1] : null
}

// --- combining ------------------------------------------------------------

/**
 * The filename wins where both speak, because it is exact data rather than a
 * reading of pixels. OCR fills in what the filename cannot carry.
 */
export function mergeReceipt(fromName: ReceiptFields, fromOcr: ReceiptFields): ReceiptFields {
  const out: ReceiptFields = { ...fromOcr, ...strip(fromName), from: { ...fromOcr.from } }
  for (const [k, v] of Object.entries(fromName.from)) {
    out.from[k as keyof ReceiptFields['from']] = v as 'filename' | 'ocr'
  }
  return out
}

function strip(f: ReceiptFields): Partial<ReceiptFields> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(f)) {
    if (k !== 'from' && v !== undefined) out[k] = v
  }
  return out as Partial<ReceiptFields>
}

/** A short note recording where the entry came from. */
export function receiptNote(f: ReceiptFields): string {
  const bits: string[] = []
  if (f.payeeAccountName && f.payeeAccountName !== f.payee) bits.push(f.payeeAccountName)
  if (f.time) bits.push(f.time)
  return bits.join(' · ')
}
