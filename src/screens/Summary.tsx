import type { Id } from '../db/ids'
import { useLiveQuery } from 'dexie-react-hooks'
import { Link } from 'react-router-dom'
import { BackupNag } from '../components/BackupNag'
import { AreaTimeline, BarList, ChartCard, Columns, StackedBar } from '../components/charts'
import { Screen, Select } from '../components/ui'
import { db } from '../db/schema'
import { summarise, withOther, type SummaryFilter } from '../db/summary'
import { formatDate, formatMonth, formatMonthShort, todayStr, toDateStr } from '../lib/date'
import { formatPaise, formatPaiseCompact } from '../lib/money'
import { usePref } from '../lib/prefs'

const RANGES = [
  { key: 'all', label: 'All time' },
  { key: '30d', label: '30 days' },
  { key: '90d', label: '90 days' },
  { key: 'ytd', label: 'This year' },
] as const
type RangeKey = (typeof RANGES)[number]['key']

function rangeStart(key: RangeKey): string | undefined {
  const now = new Date()
  if (key === '30d') return toDateStr(new Date(now.getTime() - 29 * 86400000))
  if (key === '90d') return toDateStr(new Date(now.getTime() - 89 * 86400000))
  if (key === 'ytd') return `${now.getFullYear()}-01-01`
  return undefined
}

export default function Summary() {
  // Filters live above every widget and scope all of them, so the numbers agree.
  const [projectId, setProjectId] = usePref<Id | undefined>('summaryProject', undefined)
  const [range, setRange] = usePref<RangeKey>('summaryRange', 'all')

  const projects = useLiveQuery(() => db.projects.toArray(), [], [])

  const filter: SummaryFilter = {
    projectId,
    from: rangeStart(range),
    to: range === 'all' ? undefined : todayStr(),
  }

  const data = useLiveQuery(
    () => summarise(filter),
    [projectId, range],
  )

  if (!data) return <Screen title="Summary"><div /></Screen>

  const {
    spent, fundsIn, available, txnCount, payeeCount, firstDate, lastDate,
    timeline, byMonth, byCategory, bySource, byPayee, byProject,
  } = data

  const scopeLabel = [
    projectId ? projects.find((p) => p.id === projectId)?.name : 'All properties',
    RANGES.find((r) => r.key === range)!.label.toLowerCase(),
  ]
    .filter(Boolean)
    .join(' · ')

  // Only spend the axis width on a year when the range actually crosses one.
  const spansYears = new Set(byMonth.map((m) => m.month.slice(0, 4))).size > 1
  const categories = withOther(byCategory, 7)
  const sources = withOther(bySource, 5)
  const payeeRows = withOther(byPayee, 7)

  return (
    <Screen
      title="Summary"
      action={
        <Link
          to="/data"
          className="rounded-lg border border-line px-3 py-2.5 text-sm font-semibold"
        >
          Data
        </Link>
      }
    >
      <div className="mx-auto max-w-2xl space-y-4">
        <BackupNag />

        {/* One filter row, above everything it scopes. */}
        <div className="flex flex-wrap items-center gap-2">
          <Select
            aria-label="Property"
            value={projectId ?? ''}
            onChange={(e) => setProjectId(e.target.value || undefined)}
            className="!w-auto !py-2 !text-sm"
          >
            <option value="">All properties</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </Select>
          <div className="flex rounded-lg border border-line bg-surface p-0.5" role="group" aria-label="Date range">
            {RANGES.map((r) => (
              <button
                key={r.key}
                type="button"
                aria-pressed={range === r.key}
                onClick={() => setRange(r.key)}
                className={`rounded-md px-2.5 py-1.5 text-xs font-medium transition ${
                  range === r.key ? 'bg-accent text-white' : 'text-muted hover:bg-ground'
                }`}
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>

        {txnCount === 0 ? (
          <div className="rounded-xl border border-dashed border-line px-4 py-12 text-center">
            <p className="font-medium text-muted">Nothing recorded in this range</p>
            <p className="mx-auto mt-1 max-w-xs text-sm text-muted">
              Widen the date range, or add a payment from the Add tab.
            </p>
          </div>
        ) : (
          <>
            {/* The one hero figure. Proportional figures — tabular-nums would
                make a number this large read loose. */}
            <section className="rounded-xl border border-line bg-surface px-4 py-5">
              <p className="text-xs font-medium tracking-wide text-muted uppercase">
                Spent · {scopeLabel}
              </p>
              <p className="mt-1 text-5xl font-semibold leading-none">
                {formatPaiseCompact(spent)}
              </p>
              <p className="mt-2 text-sm text-muted">
                {formatPaise(spent)} across {txnCount} {txnCount === 1 ? 'entry' : 'entries'}
                {firstDate && lastDate ? `, ${formatDate(firstDate)} to ${formatDate(lastDate)}` : ''}
              </p>
            </section>

            <div className="grid grid-cols-3 gap-3">
              <Tile label="Funds in" value={formatPaiseCompact(fundsIn)} />
              <Tile
                label="Available"
                value={fundsIn > 0 ? formatPaiseCompact(available) : '—'}
                hint={fundsIn > 0 ? undefined : 'Record funds in'}
              />
              <Tile label="Paid to" value={`${payeeCount}`} hint={payeeCount === 1 ? 'payee' : 'payees'} />
            </div>

            <ChartCard
              title="Spend over time"
              subtitle="Running total, cumulative"
              empty={timeline.length < 2}
              table={{
                columns: ['Date', 'That day', 'Running total'],
                rows: timeline
                  .slice()
                  .reverse()
                  .map((p) => [formatDate(p.date), formatPaise(p.daily), formatPaise(p.cumulative)]),
              }}
            >
              <AreaTimeline points={timeline} formatDateLabel={formatDate} />
            </ChartCard>

            <ChartCard
              title="By month"
              subtitle="What each month cost"
              empty={byMonth.length === 0}
              table={{
                columns: ['Month', 'Spent'],
                rows: byMonth.slice().reverse().map((m) => [formatMonth(m.month), formatPaise(m.total)]),
              }}
            >
              <Columns
                bars={byMonth.map((m) => ({ key: m.month, label: m.month, value: m.total }))}
                formatLabel={(k) => formatMonthShort(k, spansYears)}
              />
            </ChartCard>

            <ChartCard
              title="Where it went"
              subtitle={`${byCategory.length} cost heads`}
              empty={byCategory.length === 0}
              table={{
                columns: ['Cost head', 'Spent', 'Share'],
                rows: byCategory.map((c) => [
                  c.name,
                  formatPaise(c.total),
                  `${((c.total / (spent || 1)) * 100).toFixed(1)}%`,
                ]),
              }}
            >
              <BarList rows={categories} total={spent} />
            </ChartCard>

            <ChartCard
              title="Which source paid"
              subtitle="Share of spending by account"
              empty={bySource.length === 0}
              table={{
                columns: ['Source', 'Spent', 'Share'],
                rows: bySource.map((s) => [
                  s.name,
                  formatPaise(s.total),
                  `${((s.total / (spent || 1)) * 100).toFixed(1)}%`,
                ]),
              }}
            >
              <StackedBar rows={sources} />
            </ChartCard>

            <ChartCard
              title="Paid to"
              subtitle={payeeCount ? `Top recipients of ${payeeCount}` : 'No payees assigned yet'}
              empty={byPayee.length === 0}
              emptyMessage={
                <>
                  None of these entries name a recipient. Imported history usually arrives this
                  way — open a row in the{' '}
                  <Link to="/ledger" className="font-medium text-accent">
                    ledger
                  </Link>{' '}
                  to assign who was paid.
                </>
              }
              table={{
                columns: ['Payee', 'Role', 'Paid'],
                rows: byPayee.map((p) => [p.name, p.role, formatPaise(p.total)]),
              }}
            >
              <BarList rows={payeeRows} total={spent} unitLabel="of all spending" />
            </ChartCard>

            {byProject.length > 1 && !projectId && (
              <ChartCard
                title="By property"
                subtitle="Spending compared"
                table={{
                  columns: ['Property', 'Spent', 'Share'],
                  rows: byProject.map((p) => [
                    p.name,
                    formatPaise(p.total),
                    `${((p.total / (spent || 1)) * 100).toFixed(1)}%`,
                  ]),
                }}
              >
                <BarList rows={byProject} total={spent} />
              </ChartCard>
            )}
          </>
        )}
      </div>
    </Screen>
  )
}

/**
 * Stat tile: label in sentence case, value in proportional figures. No
 * sparkline here — the timeline card below carries the trend.
 */
function Tile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-line bg-surface px-3 py-2.5">
      <div className="text-xs text-muted">{label}</div>
      <div className="mt-0.5 text-lg font-semibold leading-tight">{value}</div>
      {hint && <div className="text-[11px] text-muted">{hint}</div>}
    </div>
  )
}
