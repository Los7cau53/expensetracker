import { useEffect, useRef, useState } from 'react'
import { coerceToDateStr, formatDate } from '../lib/date'

/**
 * A date field that always reads and writes dd/mm/yyyy.
 *
 * `<input type="date">` renders in the *browser's* locale, which a page cannot
 * set — `lang` on the document does not affect it. On a machine set to US
 * English the same stored date showed as 02/12/2026 in the field while the
 * app's own text showed 12/02/2026 beside it. Worse than looking inconsistent:
 * a date typed meaning 12 February could be stored as 2 December.
 *
 * So the typing surface is a plain text input, formatted by us. The native
 * picker is kept alongside — it is genuinely the best way to choose a date on
 * a phone — but it only ever *sets* the value, never displays it.
 */
export function DateField({
  value,
  onChange,
  id,
  allowEmpty = false,
}: {
  /** 'YYYY-MM-DD', or '' when empty is allowed. */
  value: string
  onChange: (next: string) => void
  id?: string
  allowEmpty?: boolean
}) {
  const [text, setText] = useState(() => (value ? formatDate(value) : ''))
  // What we last told the parent, so an external change can be told apart from
  // our own echo — otherwise syncing down would fight the typing.
  const emitted = useRef(value)

  useEffect(() => {
    if (value !== emitted.current) {
      setText(value ? formatDate(value) : '')
      emitted.current = value
    }
  }, [value])

  const trimmed = text.trim()
  const parsed = trimmed ? coerceToDateStr(trimmed, true) : null
  const invalid = trimmed !== '' && !parsed

  function handleType(raw: string) {
    // Slashes are inserted as the digits arrive, so the shape is never in
    // doubt while half-typed.
    const digits = raw.replace(/\D/g, '').slice(0, 8)
    const parts = [digits.slice(0, 2), digits.slice(2, 4), digits.slice(4, 8)].filter(Boolean)
    const next = parts.join('/')
    setText(next)

    if (!next && allowEmpty) {
      emitted.current = ''
      onChange('')
      return
    }
    // Only a complete, real date is pushed up; a partial one would land as a
    // wrong date on every keystroke.
    if (digits.length === 8) {
      const iso = coerceToDateStr(next, true)
      if (iso) {
        emitted.current = iso
        onChange(iso)
      }
    }
  }

  return (
    <div>
      <div className="flex items-stretch gap-2">
        <input
          id={id}
          value={text}
          onChange={(e) => handleType(e.target.value)}
          inputMode="numeric"
          autoComplete="off"
          placeholder="dd/mm/yyyy"
          aria-invalid={invalid || undefined}
          className={`tnum min-w-0 flex-1 rounded-lg border bg-surface px-3 py-2.5 text-base outline-none focus:ring-2 focus:ring-accent/20 ${
            invalid ? 'border-out' : 'border-line focus:border-accent'
          }`}
        />

        {/* The native picker, kept for touch. It sets the value; it never shows
            it, so its locale cannot mislead anyone. */}
        <label
          className="relative flex w-11 shrink-0 cursor-pointer items-center justify-center rounded-lg border border-line bg-surface text-lg text-muted hover:bg-ground"
          title="Pick from a calendar"
        >
          <span aria-hidden>▦</span>
          <input
            type="date"
            value={value || ''}
            onChange={(e) => {
              emitted.current = e.target.value
              setText(e.target.value ? formatDate(e.target.value) : '')
              onChange(e.target.value)
            }}
            aria-label="Pick a date from a calendar"
            className="absolute inset-0 cursor-pointer opacity-0"
          />
        </label>
      </div>

      {invalid && <span className="mt-1 block text-xs text-out">Use dd/mm/yyyy.</span>}
    </div>
  )
}
