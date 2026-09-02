import { useMemo, useRef, useState } from 'react'

export interface ComboOption {
  id: number
  name: string
  sub?: string
}

/**
 * Searchable picker with create-on-type. Built for the add-entry hot path:
 * typing "elec" narrows to the electrician, and typing a brand-new mestri's
 * name offers to create them inline rather than forcing a detour to a
 * settings screen mid-payment.
 */
export function ComboBox({
  options,
  value,
  onChange,
  onCreate,
  placeholder = 'Search or type a new name',
  allowClear = false,
}: {
  options: ComboOption[]
  value?: number
  onChange: (id: number | undefined) => void
  onCreate?: (name: string) => Promise<number>
  placeholder?: string
  allowClear?: boolean
}) {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const selected = options.find((o) => o.id === value)

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return options.slice(0, 50)
    return options.filter((o) => o.name.toLowerCase().includes(q)).slice(0, 50)
  }, [options, query])

  const trimmed = query.trim()
  const exactExists = options.some((o) => o.name.toLowerCase() === trimmed.toLowerCase())
  const canCreate = Boolean(onCreate) && trimmed.length > 0 && !exactExists

  async function create() {
    if (!onCreate || !trimmed) return
    setBusy(true)
    try {
      const id = await onCreate(trimmed)
      onChange(id)
      setQuery('')
      setOpen(false)
    } finally {
      setBusy(false)
    }
  }

  function pick(id: number) {
    onChange(id)
    setQuery('')
    setOpen(false)
  }

  if (selected && !open) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-line bg-surface px-3 py-2.5">
        <span className="min-w-0 flex-1 truncate text-base">{selected.name}</span>
        <button
          type="button"
          className="shrink-0 text-sm font-medium text-accent"
          onClick={() => {
            setOpen(true)
            requestAnimationFrame(() => inputRef.current?.focus())
          }}
        >
          Change
        </button>
        {allowClear && (
          <button
            type="button"
            className="shrink-0 text-sm text-muted"
            onClick={() => onChange(undefined)}
          >
            Clear
          </button>
        )}
      </div>
    )
  }

  return (
    <div className="relative">
      <input
        ref={inputRef}
        value={query}
        placeholder={placeholder}
        onChange={(e) => {
          setQuery(e.target.value)
          setOpen(true)
        }}
        onFocus={() => setOpen(true)}
        // Delay so a click on an option registers before the list unmounts.
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            if (matches.length === 1) pick(matches[0].id)
            else if (canCreate) void create()
          }
          if (e.key === 'Escape') setOpen(false)
        }}
        className="w-full rounded-lg border border-line bg-surface px-3 py-2.5 text-base outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
      />

      {open && (matches.length > 0 || canCreate) && (
        <ul className="absolute z-20 mt-1 max-h-64 w-full overflow-auto rounded-lg border border-line bg-surface shadow-lg">
          {canCreate && (
            <li>
              <button
                type="button"
                disabled={busy}
                onClick={() => void create()}
                className="w-full px-3 py-2.5 text-left text-sm font-semibold text-accent hover:bg-ground"
              >
                + Add “{trimmed}”
              </button>
            </li>
          )}
          {matches.map((o) => (
            <li key={o.id}>
              <button
                type="button"
                onClick={() => pick(o.id)}
                className="flex w-full items-baseline justify-between gap-2 px-3 py-2.5 text-left hover:bg-ground"
              >
                <span className="truncate">{o.name}</span>
                {o.sub && <span className="shrink-0 text-xs text-muted">{o.sub}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
