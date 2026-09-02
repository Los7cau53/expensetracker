import { describe, expect, it } from 'vitest'
import { formatPaise, formatPaiseCompact, parseAmountToPaise } from './money'

describe('parseAmountToPaise', () => {
  it('parses plain and Indian-grouped rupee strings', () => {
    expect(parseAmountToPaise('1234')).toBe(123400)
    expect(parseAmountToPaise('1,23,456.50')).toBe(12345650)
    expect(parseAmountToPaise('₹ 2,000')).toBe(200000)
    expect(parseAmountToPaise('99.99')).toBe(9999)
  })

  it('treats Excel numeric cells as rupees', () => {
    expect(parseAmountToPaise(4500)).toBe(450000)
    expect(parseAmountToPaise(0.5)).toBe(50)
  })

  it('reads accounting negatives', () => {
    expect(parseAmountToPaise('(500)')).toBe(-50000)
    expect(parseAmountToPaise('-500')).toBe(-50000)
  })

  it('returns null rather than zero for unparseable input', () => {
    // A silent zero would import a bogus row; the caller must be able to reject it.
    for (const bad of ['', '   ', 'n/a', '-', 'abc', null, undefined, 'Rs. approx']) {
      expect(parseAmountToPaise(bad)).toBeNull()
    }
  })

  it('avoids float drift that would break balance reconciliation', () => {
    const total = ['0.1', '0.2'].reduce((a, s) => a + parseAmountToPaise(s)!, 0)
    expect(total).toBe(30)
    expect(formatPaise(total)).toBe('₹0.30')
  })
})

describe('formatPaiseCompact', () => {
  it('uses the Indian scale — thousands, lakh, crore', () => {
    expect(formatPaiseCompact(0)).toBe('₹0')
    expect(formatPaiseCompact(45000)).toBe('₹450')
    expect(formatPaiseCompact(450000)).toBe('₹4.5K')
    expect(formatPaiseCompact(1_93_250_50)).toBe('₹1.93L')
    expect(formatPaiseCompact(2_00_000_00)).toBe('₹2L')
    expect(formatPaiseCompact(4_50_00_000_00)).toBe('₹4.5Cr')
  })

  it('keeps the sign on a reversal', () => {
    expect(formatPaiseCompact(-1_41_007_00)).toBe('-₹1.41L')
  })
})
