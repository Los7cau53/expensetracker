import { describe, expect, it } from 'vitest'
import {
  mergeReceipt,
  parseGpayFilename,
  parseGpayText,
  receiptNote,
} from './gpay'

/**
 * Verbatim Tesseract output from a real Google Pay receipt screenshot
 * (dark theme, 1080x2528). Kept exactly as OCR produced it, mangling and
 * all — the parser's job is to cope with this, not with cleaned-up text.
 */
const REAL_OCR = `_ a
: y
To prakash Raj Raj
+91 eevee 26202
16,000
© Completed
27 Aug 2026, 5:42pm
fi (ciciBanko763 v
UPI transaction ID
660550753690
To: TRAJU
Google Pay * +++-73-3@oksbi
From: RATNA TEJA CH (ICICI Bank)
Google Pay + -+--ja06@okaxis
Google transaction ID
CICAgLin5fnRJQ
G Pay`

const REAL_FILENAME = '1787832753 - 16000.00 To prakash Raj Raj on Google Pay.png'

describe('filename', () => {
  it('reads amount, date, time, payee and direction exactly', () => {
    const f = parseGpayFilename(REAL_FILENAME)

    expect(f.amount).toBe(16_000_00)
    expect(f.date).toBe('2026-08-27')
    expect(f.time).toBe('17:42')
    expect(f.payee).toBe('prakash Raj Raj')
    expect(f.direction).toBe('out')
    // Everything here came from the name, not from pixels.
    expect(f.from.amount).toBe('filename')
    expect(f.from.date).toBe('filename')
  })

  it('reads a received payment as money in', () => {
    const f = parseGpayFilename('1787832753 - 5000.00 from Dad on Google Pay.png')
    expect(f.direction).toBe('in')
    expect(f.payee).toBe('Dad')
  })

  it('accepts a millisecond timestamp', () => {
    const f = parseGpayFilename('1787832753000 - 100.50 To X on Google Pay.png')
    expect(f.date).toBe('2026-08-27')
    expect(f.amount).toBe(100_50)
  })

  it('returns nothing for a plain screenshot name', () => {
    for (const n of ['IMG_4821.PNG', 'Screenshot 2026-08-27 at 17.42.33.png', 'photo.jpg']) {
      const f = parseGpayFilename(n)
      expect(f.amount).toBeUndefined()
      expect(f.payee).toBeUndefined()
      expect(f.date).toBeUndefined()
    }
  })
})

describe('OCR text', () => {
  const f = parseGpayText(REAL_OCR)

  it('picks the amount, not the masked phone number', () => {
    // "26202" is the tail of "+91 ••••• •6202" and is numerically larger than
    // 16,000 — taking the largest number on screen would get this wrong.
    expect(f.amount).toBe(16_000_00)
  })

  it('reads the date and time', () => {
    expect(f.date).toBe('2026-08-27')
    expect(f.time).toBe('17:42')
  })

  it('takes the display name as the payee', () => {
    expect(f.payee).toBe('prakash Raj Raj')
  })

  it('keeps the recipient bank-account name separately', () => {
    // "To: TRAJU" is the account holder, not the contact name.
    expect(f.payeeAccountName).toBe('TRAJU')
  })

  it('recovers the bank from the clean From: line', () => {
    expect(f.bank).toBe('ICICI Bank')
  })

  it('recovers the account last-4 despite OCR reading 0 as o', () => {
    // The header chip came through as "fi (ciciBanko763 v".
    expect(f.bankLast4).toBe('0763')
  })

  it('takes the UPI transaction ID as the reference', () => {
    expect(f.reference).toBe('660550753690')
  })

  it('reads the status and the direction', () => {
    expect(f.status).toBe('completed')
    expect(f.direction).toBe('out')
  })
})

describe('status detection', () => {
  it('spots a failed payment, so it is not filed as spending', () => {
    expect(parseGpayText('To X\n1,000\nPayment failed\n1 Jan 2026').status).toBe('failed')
    expect(parseGpayText('To X\n1,000\nDeclined').status).toBe('failed')
  })

  it('spots a pending one', () => {
    expect(parseGpayText('To X\n1,000\nPending').status).toBe('pending')
  })

  it('says unknown rather than guessing completed', () => {
    expect(parseGpayText('To X\n1,000').status).toBe('unknown')
  })
})

describe('amount picking', () => {
  it('accepts a rupee-marked bare number', () => {
    expect(parseGpayText('To X\n₹4500\n1 Jan 2026').amount).toBe(4_500_00)
  })

  it('accepts decimals and grouping', () => {
    expect(parseGpayText('To X\n18,750.50').amount).toBe(18_750_50)
    expect(parseGpayText('To X\n1,44,704.14').amount).toBe(1_44_704_14)
  })

  it('ignores transaction ids and UPI handles', () => {
    const f = parseGpayText('To X\nUPI transaction ID\n660550753690\nsomething@oksbi')
    expect(f.amount).toBeUndefined()
  })

  it('ignores a bare digit run with no currency marker', () => {
    // Could be an id, a reference or a masked number — never assume rupees.
    expect(parseGpayText('To X\n26202').amount).toBeUndefined()
  })
})

describe('merging both sources', () => {
  it('prefers the filename where both speak, and fills the rest from OCR', () => {
    const merged = mergeReceipt(parseGpayFilename(REAL_FILENAME), parseGpayText(REAL_OCR))

    expect(merged.amount).toBe(16_000_00)
    expect(merged.from.amount).toBe('filename')
    expect(merged.date).toBe('2026-08-27')
    expect(merged.from.date).toBe('filename')

    // Only the image carries these.
    expect(merged.bank).toBe('ICICI Bank')
    expect(merged.bankLast4).toBe('0763')
    expect(merged.reference).toBe('660550753690')
    expect(merged.from.bank).toBe('ocr')
    expect(merged.from.reference).toBe('ocr')
  })

  it('falls back entirely to OCR for a plain screenshot', () => {
    const merged = mergeReceipt(parseGpayFilename('IMG_0001.PNG'), parseGpayText(REAL_OCR))

    expect(merged.amount).toBe(16_000_00)
    expect(merged.from.amount).toBe('ocr')
    expect(merged.payee).toBe('prakash Raj Raj')
    expect(merged.from.payee).toBe('ocr')
  })

  it('works from the filename alone when OCR is skipped', () => {
    const merged = mergeReceipt(parseGpayFilename(REAL_FILENAME), { from: {} })
    expect(merged.amount).toBe(16_000_00)
    expect(merged.payee).toBe('prakash Raj Raj')
    expect(merged.bank).toBeUndefined()
  })
})

describe('receiptNote', () => {
  it('records the account name and time without repeating the payee', () => {
    const merged = mergeReceipt(parseGpayFilename(REAL_FILENAME), parseGpayText(REAL_OCR))
    expect(receiptNote(merged)).toBe('TRAJU · 17:42')
  })

  it('omits the account name when it matches the payee', () => {
    expect(receiptNote({ payee: 'T RAJU', payeeAccountName: 'T RAJU', time: '09:15', from: {} })).toBe(
      '09:15',
    )
  })
})
