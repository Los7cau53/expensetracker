import { coerceToDateStr, toDateStr, type DateStr } from './date'
import { parseAmountToPaise, type Paise } from './money'

/**
 * Reads a Google Pay receipt, from its filename and from OCR of the image.
 *
 * OCR of the image is the path that has to work, because a screenshot taken
 * with the volume buttons is named IMG_4821.PNG and carries nothing. Every
 * field — amount, date, time, payee, bank, reference — is recoverable from the
 * pixels alone, and is verified that way against a real receipt.
 *
 * The filename is a bonus, not the mechanism. A file shared out of Google Pay
 * happens to be named
 *
 *   1787832753 - 16000.00 To prakash Raj Raj on Google Pay.png
 *
 * carrying the epoch timestamp, amount and payee exactly. Where that is
 * present it is preferred over OCR, since it is data rather than a reading of
 * pixels — but nothing depends on it.
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
 * share the screen.
 *
 * Scored rather than pattern-gated, because OCR drops the rupee sign outright
 * ("₹16,000" comes back as "16,000") and Google Pay writes no grouping comma
 * below a thousand — so requiring a currency marker silently loses every
 * payment under ₹1,000. Position carries the weight instead: the amount sits
 * high on a receipt, just under the payee, while identifiers sit far below.
 */
function pickAmount(lines: string[]): Paise | null {
  let bestPaise: Paise | null = null
  let bestScore = 0

  for (const [index, line] of lines.entries()) {
    // Context that means this line is never the amount.
    if (/\+91|transaction|@|\bupi\b|\bid\b/i.test(line)) continue
    // A long digit run is a reference, not money.
    if (/\d{10,}/.test(line.replace(/[,\s]/g, ''))) continue

    const m = line.match(/^[₹?%*\s]*([\d][\d,]*(?:\.\d{1,2})?)\s*$/)
    if (!m) continue

    const raw = m[1]
    const paise = parseAmountToPaise(raw)
    // Nothing here runs past a crore.
    if (paise === null || paise <= 0 || paise > 100_00_00_000_00) continue

    let score = 0
    if (/₹/.test(line)) score += 4
    if (raw.includes(',')) score += 2
    if (raw.includes('.')) score += 1
    // Google Pay's layout: payee, masked number, then the amount.
    if (index < 8) score += 2
    else if (index < 12) score += 1

    // A bare digit run far down the receipt is an identifier of some kind.
    if (score < 2) continue
    if (bestPaise === null || score > bestScore || (score === bestScore && paise > bestPaise)) {
      bestPaise = paise
      bestScore = score
    }
  }

  return bestPaise
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
