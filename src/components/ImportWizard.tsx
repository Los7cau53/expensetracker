import { useLiveQuery } from 'dexie-react-hooks'
import { useMemo, useState } from 'react'
import {
  analyze,
  commitImport,
  defaultAliases,
  EMPTY_MAPPING,
  guessHeader,
  guessMapping,
  IMPORT_FIELDS,
  readWorkbook,
  type Aliases,
  type Analysis,
  type ImportField,
  type Mapping,
  type SheetData,
} from '../lib/excelImport'
import { todayStr } from '../lib/date'
import { formatPaise } from '../lib/money'
import { byCreated } from '../db/ids'
import { db } from '../db/schema'
import { DateField } from './DateField'
import { Button, Card, Field, Money, Select, TextInput } from './ui'

/** Columns are addressed by position when a sheet has no header row. */
function widestRow(sheet: SheetData | undefined): number {
  if (!sheet) return 0
  return sheet.rows.reduce((w, r) => Math.max(w, r.length), 0)
}

const FIELD_LABELS: Record<ImportField, string> = {
  date: 'Date *',
  amount: 'Amount *',
  project: 'Property',
  payee: 'Paid to',
  category: 'For what',
  source: 'Paid from',
  note: 'Note',
  refNo: 'Reference',
}

export function ImportWizard({ onDone }: { onDone: () => void }) {
  const [sheets, setSheets] = useState<SheetData[] | null>(null)
  const [fileName, setFileName] = useState('')
  const [sheetIndex, setSheetIndex] = useState(0)
  const [headerRow, setHeaderRow] = useState(0)
  const [hasHeader, setHasHeader] = useState(true)
  const [mapping, setMapping] = useState<Mapping | null>(null)
  const [dayFirst, setDayFirst] = useState(true)
  const [fallbackDate, setFallbackDate] = useState('')
  const [categoryName, setCategoryName] = useState('')
  const [asFundIns, setAsFundIns] = useState(false)
  const [aliases, setAliases] = useState<Aliases | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<string | null>(null)

  // The import's fallbacks are taken from [0], so the order must be defined.
  const projects = useLiveQuery(async () => byCreated(await db.projects.toArray()), [], [])
  const sources = useLiveQuery(async () => byCreated(await db.sources.toArray()), [], [])
  const categories = useLiveQuery(() => db.categories.orderBy('sortOrder').toArray(), [], [])

  const sheet = sheets?.[sheetIndex]

  const analysis: Analysis | null = useMemo(() => {
    if (!sheet || !mapping) return null
    if (mapping.amount === null) return null
    // A date column is optional as long as there is a date to fall back on.
    if (mapping.date === null && !fallbackDate) return null
    return analyze(sheet.rows, headerRow, mapping, {
      dayFirst,
      hasHeader,
      fallbackDate: fallbackDate || undefined,
    })
  }, [sheet, mapping, headerRow, hasHeader, dayFirst, fallbackDate])

  // Seed the alias table the first time an analysis appears for this mapping.
  const effectiveAliases = useMemo(() => {
    if (!analysis) return null
    return aliases ?? defaultAliases(analysis.distinct)
  }, [analysis, aliases])

  async function pickFile(file: File) {
    setError(null)
    setResult(null)
    setBusy(true)
    try {
      const data = await readWorkbook(file)
      if (data.length === 0) throw new Error('That workbook has no sheets.')
      const first = data[0]
      const { headerRow: hr, hasHeader: hh } = guessHeader(first.rows)
      setSheets(data)
      setFileName(file.name)
      setSheetIndex(0)
      setHeaderRow(hr)
      setHasHeader(hh)
      setMapping(hh ? guessMapping(first.rows[hr] ?? []) : { ...EMPTY_MAPPING })
      setCategoryName(first.name)
      setAsFundIns(false)
      setAliases(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not read that file.')
    } finally {
      setBusy(false)
    }
  }

  function switchSheet(i: number) {
    if (!sheets) return
    const { headerRow: hr, hasHeader: hh } = guessHeader(sheets[i].rows)
    setSheetIndex(i)
    setHeaderRow(hr)
    setHasHeader(hh)
    setMapping(hh ? guessMapping(sheets[i].rows[hr] ?? []) : { ...EMPTY_MAPPING })
    // One tab per job is a common layout, so the tab name is the best default
    // cost head for a sheet with no category column.
    setCategoryName(sheets[i].name.trim())
    setAsFundIns(false)
    setAliases(null)
  }

  const referencesReady = projects.length > 0 && sources.length > 0 && categories.length > 0

  async function commit() {
    if (!analysis || !effectiveAliases || !sheet) return
    if (!referencesReady) {
      setError('Still loading your properties and sources — try again in a moment.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const res = await commitImport(analysis, effectiveAliases, {
        fileName,
        sheetName: sheet.name,
        headerRow,
        mapping: mapping!,
        fallbackProjectId: projects[0].id,
        fallbackSourceId: sources[0].id,
        fallbackCategoryId: categories[categories.length - 1].id,
        fallbackCategoryName: categoryName.trim() || undefined,
        asFundIns,
      })
      setResult(
        res.asFundIns
          ? `Imported ${res.inserted} fund inflows. Created ${res.created.sources} sources. ` +
            `These top up source balances and are not counted as spending.`
          : `Imported ${res.inserted} entries. Created ${res.created.projects} properties, ` +
            `${res.created.payees} payees, ${res.created.categories} categories, ` +
            `${res.created.sources} sources.`,
      )
      setSheets(null)
      setMapping(null)
      setAliases(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Import failed.')
    } finally {
      setBusy(false)
    }
  }

  const headerCells = hasHeader
    ? sheet?.rows[headerRow] ?? []
    // With no header row, columns are addressed by position.
    : Array.from({ length: widestRow(sheet) }, (_, i) => `Column ${i + 1}`)
  const missingRequired: ImportField[] = []
  if (mapping?.amount === null || mapping === null) missingRequired.push('amount')
  if ((mapping?.date ?? null) === null && !fallbackDate) missingRequired.push('date')

  if (result) {
    return (
      <Card className="space-y-3 p-4">
        <p className="text-sm font-medium text-in">{result}</p>
        <p className="text-sm text-muted">
          Check the totals against your sheet. If anything looks wrong, undo the batch below and
          re-import with a corrected mapping.
        </p>
        <Button onClick={onDone}>Done</Button>
      </Card>
    )
  }

  return (
    <Card className="space-y-4 p-4">
      <div className="flex items-baseline justify-between">
        <h2 className="font-semibold">Import from Excel</h2>
        <button type="button" onClick={onDone} className="text-sm text-muted">
          Cancel
        </button>
      </div>

      <Field label="Spreadsheet" hint=".xlsx, .xls or .csv — read entirely on this device.">
        <input
          type="file"
          accept=".xlsx,.xls,.csv,.ods"
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) void pickFile(f)
          }}
          className="w-full text-sm"
        />
      </Field>

      {error && <p className="text-sm text-out">{error}</p>}
      {busy && <p className="text-sm text-muted">Working…</p>}

      {sheets && sheet && (
        <>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Sheet">
              <Select value={sheetIndex} onChange={(e) => switchSheet(Number(e.target.value))}>
                {sheets.map((s, i) => (
                  <option key={s.name} value={i}>
                    {s.name} ({s.rows.length} rows)
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Header row" hint={hasHeader ? '1-indexed, as Excel shows it.' : 'This sheet has no header.'}>
              <TextInput
                type="number"
                min={1}
                max={sheet.rows.length}
                disabled={!hasHeader}
                value={headerRow + 1}
                onChange={(e) => {
                  const hr = Math.max(0, Number(e.target.value) - 1)
                  setHeaderRow(hr)
                  setMapping(guessMapping(sheet.rows[hr] ?? []))
                  setAliases(null)
                }}
              />
            </Field>
          </div>

          <div className="overflow-x-auto rounded-lg border border-line">
            <table className="w-full text-xs">
              <tbody>
                {sheet.rows.slice(headerRow, headerRow + 4).map((row, ri) => (
                  <tr key={ri} className={ri === 0 ? 'bg-ground font-semibold' : ''}>
                    {row.slice(0, 10).map((c, ci) => (
                      <td key={ci} className="max-w-32 truncate border-r border-line px-2 py-1">
                        {c === null ? '' : String(c)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div>
            <h3 className="mb-2 text-xs font-semibold tracking-wide text-muted uppercase">
              Match your columns
            </h3>
            <div className="grid grid-cols-2 gap-3">
              {IMPORT_FIELDS.map((f) => (
                <Field key={f} label={FIELD_LABELS[f]}>
                  <Select
                    value={mapping?.[f] ?? ''}
                    onChange={(e) =>
                      setMapping((m) => ({
                        ...(m ?? ({} as Mapping)),
                        [f]: e.target.value === '' ? null : Number(e.target.value),
                      }))
                    }
                  >
                    <option value="">— not in sheet —</option>
                    {headerCells.map((h, i) => (
                      <option key={i} value={i}>
                        {String(h ?? `Column ${i + 1}`) || `Column ${i + 1}`}
                      </option>
                    ))}
                  </Select>
                </Field>
              ))}
            </div>
          </div>

          <div className="space-y-3 rounded-lg border border-line p-3">
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-1"
                checked={asFundIns}
                onChange={(e) => setAsFundIns(e.target.checked)}
              />
              <span>
                These rows are money coming <strong>in</strong>, not payments
                <span className="mt-0.5 block text-xs text-muted">
                  For tabs that record cash withdrawals, transfers from family or loan
                  tranches. They top up a source's balance instead of counting as spending —
                  importing them as payments would double-count, since the same money is
                  spent again on the work tabs.
                </span>
              </span>
            </label>

            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={hasHeader}
                onChange={(e) => {
                  const v = e.target.checked
                  setHasHeader(v)
                  setMapping(v ? guessMapping(sheet.rows[headerRow] ?? []) : { ...EMPTY_MAPPING })
                  setAliases(null)
                }}
              />
              This sheet has a header row
              {!hasHeader && (
                <span className="text-xs text-muted">— row 1 is treated as data</span>
              )}
            </label>

            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={dayFirst}
                onChange={(e) => setDayFirst(e.target.checked)}
              />
              Dates are day-first (03/04 means 3 April)
            </label>

            {!asFundIns && (
              <Field
                label="Cost head for this sheet"
                hint="Used for rows with no category of their own. Defaults to the sheet name."
              >
                <TextInput
                  value={categoryName}
                  onChange={(e) => setCategoryName(e.target.value)}
                  placeholder="e.g. Borewell"
                />
              </Field>
            )}

            <Field
              label="Date for rows without one"
              hint="Sheets that track a single job often omit dates. Leave blank to reject those rows instead."
            >
              <div className="flex gap-2">
                <div className="min-w-0 flex-1">
                  <DateField allowEmpty value={fallbackDate} onChange={setFallbackDate} />
                </div>
                {fallbackDate ? (
                  <Button variant="secondary" onClick={() => setFallbackDate('')}>
                    Clear
                  </Button>
                ) : (
                  <Button variant="secondary" onClick={() => setFallbackDate(todayStr())}>
                    Today
                  </Button>
                )}
              </div>
            </Field>
          </div>

          {missingRequired.length > 0 ? (
            <p className="text-sm text-out">
              Pick a column for {missingRequired.join(' and ')} to see the preview.
            </p>
          ) : (
            analysis &&
            effectiveAliases && (
              <>
                <div className="grid grid-cols-3 gap-3">
                  <Stat2 label="Rows to import" value={String(analysis.valid.length)} />
                  <Stat2 label="Net total" value={formatPaise(analysis.total)} />
                  <Stat2
                    label="Rejected"
                    value={String(analysis.rejected.length)}
                    tone={analysis.rejected.length ? 'text-out' : undefined}
                  />
                </div>

                {analysis.inflow > 0 && (
                  <p className="rounded-lg bg-in/10 px-3 py-2 text-xs">
                    {formatPaise(analysis.outflow)} paid out, less{' '}
                    {formatPaise(analysis.inflow)} in negative rows (reversals or refunds), giving
                    the net total above.
                  </p>
                )}

                <p className="text-xs text-muted">
                  Compare that total against the grand total in your sheet before importing. If they
                  differ, the amount column or the header row is wrong.
                </p>

                {asFundIns && (
                  <p className="rounded-lg bg-in/10 px-3 py-2 text-xs">
                    These will be recorded as money into a source. Set “Paid from” above to the
                    column naming the account, or every row lands on the fallback source.
                  </p>
                )}

                {analysis.rejected.length > 0 && (
                  <details className="rounded-lg border border-line p-3">
                    <summary className="cursor-pointer text-sm font-medium">
                      {analysis.rejected.length} rows will be skipped
                    </summary>
                    <ul className="mt-2 max-h-48 space-y-1 overflow-auto text-xs">
                      {analysis.rejected.slice(0, 200).map((r) => (
                        <li key={r.sheetRow} className="text-muted">
                          <span className="font-medium text-out">Row {r.sheetRow}</span> —{' '}
                          {r.reason}: {r.preview}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}

                {(asFundIns
                  ? (['source'] as const)
                  : (['payee', 'source', 'category', 'project'] as const)
                ).map((dim) =>
                  analysis.distinct[dim].length > 0 ? (
                    <AliasEditor
                      key={dim}
                      dim={dim}
                      values={analysis.distinct[dim]}
                      aliases={effectiveAliases}
                      onChange={setAliases}
                    />
                  ) : null,
                )}

                <Button
                  disabled={busy || analysis.valid.length === 0 || !referencesReady}
                  onClick={() => void commit()}
                >
                  Import {analysis.valid.length} {asFundIns ? 'inflows' : 'entries'} (
                  <Money paise={asFundIns ? analysis.outflow : analysis.total} />)
                </Button>
              </>
            )
          )}
        </>
      )}
    </Card>
  )
}

function Stat2({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-lg border border-line px-3 py-2">
      <div className="text-xs text-muted">{label}</div>
      <div className={`tnum text-sm font-semibold ${tone ?? ''}`}>{value}</div>
    </div>
  )
}

/**
 * Lets the user collapse spelling variants before anything is written —
 * the difference between one mestri and four of them in every later report.
 */
function AliasEditor({
  dim,
  values,
  aliases,
  onChange,
}: {
  dim: 'project' | 'payee' | 'category' | 'source'
  values: string[]
  aliases: Aliases
  onChange: (a: Aliases) => void
}) {
  const labels = { project: 'Properties', payee: 'Payees', category: 'Categories', source: 'Sources' }
  const targets = [...new Set(values.map((v) => aliases[dim][v] ?? v))].sort()
  const merged = values.filter((v) => (aliases[dim][v] ?? v) !== v).length

  return (
    <details className="rounded-lg border border-line p-3">
      <summary className="cursor-pointer text-sm font-medium">
        {labels[dim]}: {targets.length} unique from {values.length} values
        {merged ? ` · ${merged} auto-merged` : ''}
      </summary>
      <div className="mt-2 max-h-64 space-y-2 overflow-auto">
        {values.map((v) => (
          <div key={v} className="grid grid-cols-2 items-center gap-2">
            <span className="truncate text-xs text-muted" title={v}>
              {v}
            </span>
            <TextInput
              value={aliases[dim][v] ?? v}
              onChange={(e) =>
                onChange({ ...aliases, [dim]: { ...aliases[dim], [v]: e.target.value } })
              }
              className="!py-1.5 !text-sm"
            />
          </div>
        ))}
      </div>
      <p className="mt-2 text-xs text-muted">
        Give two rows the same name to merge them. Clear a name to leave those entries unassigned.
      </p>
    </details>
  )
}
