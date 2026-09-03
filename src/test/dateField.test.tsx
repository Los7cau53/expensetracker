// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { DateField } from '../components/DateField'

afterEach(cleanup)

function Harness({ initial = '', allowEmpty = false }: { initial?: string; allowEmpty?: boolean }) {
  const [value, setValue] = useState(initial)
  return (
    <>
      <DateField value={value} onChange={setValue} allowEmpty={allowEmpty} />
      <output data-testid="stored">{value}</output>
    </>
  )
}

const typed = () => screen.getByPlaceholderText('dd/mm/yyyy') as HTMLInputElement
const stored = () => screen.getByTestId('stored').textContent

describe('DateField', () => {
  it('shows an existing date day-first, whatever the browser locale', () => {
    render(<Harness initial="2026-02-12" />)
    // The bug this replaces: a native input on a US-locale browser showed this
    // same date as 02/12/2026 while the app's own text said 12/02/2026.
    expect(typed().value).toBe('12/02/2026')
  })

  it('stores the ISO date from a day-first entry', async () => {
    const user = userEvent.setup()
    render(<Harness />)

    await user.type(typed(), '12022026')

    expect(typed().value).toBe('12/02/2026')
    expect(stored()).toBe('2026-02-12')
  })

  it('inserts the slashes as digits arrive', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    const input = typed()

    await user.type(input, '1')
    expect(input.value).toBe('1')
    await user.type(input, '2')
    expect(input.value).toBe('12')
    await user.type(input, '0')
    expect(input.value).toBe('12/0')
    await user.type(input, '2')
    expect(input.value).toBe('12/02')
  })

  it('does not store a half-typed date', async () => {
    const user = userEvent.setup()
    render(<Harness />)

    await user.type(typed(), '1202')

    // Emitting on every keystroke would land a wrong date repeatedly.
    expect(stored()).toBe('')
  })

  it('ignores anything that is not a digit', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await user.type(typed(), 'a1b2/c0d2-2026')
    expect(typed().value).toBe('12/02/2026')
    expect(stored()).toBe('2026-02-12')
  })

  it('flags an impossible date instead of storing it', async () => {
    const user = userEvent.setup()
    render(<Harness />)

    await user.type(typed(), '31022026')

    expect(await screen.findByText('Use dd/mm/yyyy.')).toBeTruthy()
    expect(typed().getAttribute('aria-invalid')).toBe('true')
    // 31 February must not silently roll into March.
    expect(stored()).toBe('')
  })

  it('accepts a day above 12, which a month-first field would reject', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await user.type(typed(), '27082026')
    expect(stored()).toBe('2026-08-27')
  })

  it('clears back to empty when that is allowed', async () => {
    const user = userEvent.setup()
    render(<Harness initial="2026-02-12" allowEmpty />)

    await user.clear(typed())

    expect(stored()).toBe('')
  })

  it('keeps a native picker available, for touch', () => {
    render(<Harness initial="2026-02-12" />)
    const picker = screen.getByLabelText('Pick a date from a calendar') as HTMLInputElement
    // It sets the value but never displays it, so its locale cannot mislead.
    expect(picker.type).toBe('date')
    expect(picker.value).toBe('2026-02-12')
  })

  it('follows the value when it changes from outside', async () => {
    const onChange = vi.fn()
    const { rerender } = render(<DateField value="2026-02-12" onChange={onChange} />)
    expect(typed().value).toBe('12/02/2026')

    rerender(<DateField value="2026-08-27" onChange={onChange} />)

    expect(typed().value).toBe('27/08/2026')
  })
})
