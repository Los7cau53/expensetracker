import { describe, expect, it } from 'vitest'
import { isOwner, OWNER_EMAILS } from './owners'

describe('owner allowlist', () => {
  it('accepts the listed account', () => {
    expect(isOwner('ratna.teja06@gmail.com')).toBe(true)
  })

  it('ignores case, as Google does for Gmail addresses', () => {
    expect(isOwner('Ratna.Teja06@Gmail.com')).toBe(true)
  })

  it('rejects anyone else', () => {
    for (const other of [
      'someone.else@gmail.com',
      'ratna.teja06@googlemail.com',
      'ratna.teja06@gmail.com.evil.com',
      'ratnateja.chinni@servicenow.com',
      '',
      null,
      undefined,
    ]) {
      expect(isOwner(other)).toBe(false)
    }
  })

  it('is a real list, so a second person can be added later', () => {
    expect(Array.isArray(OWNER_EMAILS)).toBe(true)
    expect(OWNER_EMAILS.length).toBeGreaterThan(0)
  })
})
