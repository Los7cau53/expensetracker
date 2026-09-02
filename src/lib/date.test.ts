import { describe, expect, it } from 'vitest'
import { coerceToDateStr, monthOf } from './date'

describe('coerceToDateStr', () => {
  it('passes through ISO dates', () => {
    expect(coerceToDateStr('2026-03-12')).toBe('2026-03-12')
  })

  it('reads day-first formats, which is the Indian convention', () => {
    expect(coerceToDateStr('12/03/2026')).toBe('2026-03-12')
    expect(coerceToDateStr('3-4-2026')).toBe('2026-04-03')
    expect(coerceToDateStr('12.03.26')).toBe('2026-03-12')
  })

  it('reads month-first when told to', () => {
    // Same string, opposite reading: 3 December day-first, 12 March month-first.
    expect(coerceToDateStr('03/12/2026', true)).toBe('2026-12-03')
    expect(coerceToDateStr('03/12/2026', false)).toBe('2026-03-12')
  })

  it('recovers when the day and month are the other way round', () => {
    // 25 cannot be a month, so this can only be 25 December.
    expect(coerceToDateStr('12/25/2026')).toBe('2026-12-25')
  })

  it('converts Excel serial numbers', () => {
    expect(coerceToDateStr(45000)).toBe('2023-03-15')
  })

  it('converts Date objects from SheetJS cellDates', () => {
    expect(coerceToDateStr(new Date(2026, 2, 12))).toBe('2026-03-12')
  })

  it('reads written-out month names', () => {
    expect(coerceToDateStr('12 Mar 2026')).toBe('2026-03-12')
    expect(coerceToDateStr('Mar 12, 2026')).toBe('2026-03-12')
  })

  it('rejects impossible and unreadable dates instead of guessing', () => {
    for (const bad of ['31/02/2026', 'sometime', '', null, undefined, 0, -5]) {
      expect(coerceToDateStr(bad)).toBeNull()
    }
  })

  it('does not let the lenient platform parser invent dates', () => {
    // new Date('#111111') resolves to the year 111110; an employee ID must
    // never be imported as a payment date.
    for (const bad of ['#111111', '111111', 'Employee ID', '#4471', 'GPay']) {
      expect(coerceToDateStr(bad)).toBeNull()
    }
  })
})

describe('monthOf', () => {
  it('groups by calendar month', () => {
    expect(monthOf('2026-03-12')).toBe('2026-03')
  })
})
