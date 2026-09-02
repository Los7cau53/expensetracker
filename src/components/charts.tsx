import { useState, type ReactNode } from 'react'
import { formatPaise, formatPaiseCompact } from '../lib/money'
import { barPath, GAP, HIT_MIN, niceTicks, useWidth, VIZ, BAR_MAX } from '../lib/viz'

// ---------------------------------------------------------------- chrome

/**
 * A chart in a card, with the table-view twin the accessibility pass requires.
 * The toggle is per card because the table is an alternate reading of *this*
 * chart — unlike a filter, which must scope the whole page.
 */
export function ChartCard({
  title,
  subtitle,
  table,
  children,
  empty,
  emptyMessage = 'Nothing in this range.',
}: {
  title: string
  subtitle?: string
  table: { columns: string[]; rows: (string | number)[][] }
  children: ReactNode
  empty?: boolean
  emptyMessage?: ReactNode
}) {
  const [showTable, setShowTable] = useState(false)

  return (
    <section className="rounded-xl border border-line bg-surface">
      <header className="flex items-start justify-between gap-3 px-4 pt-3 pb-2">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">{title}</h2>
          {subtitle && <p className="mt-0.5 text-xs text-muted">{subtitle}</p>}
        </div>
        {!empty && (
          <button
            type="button"
            onClick={() => setShowTable((v) => !v)}
            aria-pressed={showTable}
            className="shrink-0 rounded-md border border-line px-2 py-1 text-xs font-medium text-muted hover:bg-ground"
          >
            {showTable ? 'Chart' : 'Numbers'}
          </button>
        )}
      </header>

      <div className="px-4 pb-4">
        {empty ? (
          <div className="py-6 text-center text-sm text-muted">{emptyMessage}</div>
        ) : showTable ? (
          <DataTable {...table} />
        ) : (
          children
        )}
      </div>
    </section>
  )
}

export function DataTable({
  columns,
  rows,
}: {
  columns: string[]
  rows: (string | number)[][]
}) {
  return (
    <div className="-mx-1 max-h-80 overflow-auto">
      <table className="w-full text-sm">
        <thead className="sticky top-0 bg-surface">
          <tr className="border-b border-line text-left">
            {columns.map((c, i) => (
              <th
                key={c}
                className={`py-1.5 px-1 text-xs font-medium text-muted ${i > 0 ? 'text-right' : ''}`}
              >
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, ri) => (
            <tr key={ri} className="border-b border-line/60 last:border-0">
              {r.map((cell, ci) => (
                <td
                  key={ci}
                  className={ci > 0 ? 'tnum py-1.5 px-1 text-right' : 'py-1.5 px-1'}
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** Floating readout. Values lead, labels follow. */
function Tooltip({
  x,
  y,
  width,
  title,
  rows,
}: {
  x: number
  y: number
  width: number
  title: string
  rows: { label: string; value: string; color?: string }[]
}) {
  // Flip before the pointer once the readout would run past the right edge.
  const flip = x > width - 140
  const keyed = rows.some((r) => r.color)
  return (
    <div
      className="pointer-events-none absolute z-10 min-w-32 rounded-lg border border-line bg-surface px-2.5 py-2 shadow-lg"
      style={{
        left: flip ? undefined : x + 10,
        right: flip ? width - x + 10 : undefined,
        top: Math.max(0, y - 12),
      }}
      role="status"
    >
      <div className="mb-1 text-xs text-muted">{title}</div>
      {rows.map((r) => (
        <div key={r.label} className="flex items-baseline gap-2">
          {/* Line key, not a box — at tooltip density a filled box is
              data-weight ink doing a label's job. Keyless rows still reserve
              the column so the values stay in one vertical line. */}
          {keyed && (
            <span
              className="mt-1 h-0.5 w-3 shrink-0 rounded-full"
              style={{ background: r.color ?? 'transparent' }}
            />
          )}
          <span className="tnum text-sm font-semibold">{r.value}</span>
          <span className="truncate text-xs text-muted">{r.label}</span>
        </div>
      ))}
    </div>
  )
}

/** Legend — always present for two or more series. */
export function Legend({
  items,
  shape = 'rect',
}: {
  items: { name: string; color: string; value?: string }[]
  shape?: 'rect' | 'line'
}) {
  return (
    <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5">
      {items.map((it) => (
        <li key={it.name} className="flex items-center gap-1.5 text-xs">
          <span
            className={shape === 'line' ? 'h-0.5 w-3 rounded-full' : 'h-2.5 w-2.5 rounded-sm'}
            style={{ background: it.color }}
            aria-hidden
          />
          <span className="text-muted">{it.name}</span>
          {it.value && <span className="tnum font-medium">{it.value}</span>}
        </li>
      ))}
    </ul>
  )
}

// ---------------------------------------------------------------- timeline

export interface TimelinePoint {
  date: string
  cumulative: number
  daily: number
}

/**
 * Cumulative spend over time. One series, so the fill is a single hue wash and
 * there is no legend — the card title already says what is plotted.
 *
 * The crosshair finds the X: readers aim at a date, never at a 2px line.
 */
export function AreaTimeline({
  points,
  height = 190,
  formatDateLabel,
}: {
  points: TimelinePoint[]
  height?: number
  formatDateLabel: (d: string) => string
}) {
  const [ref, width] = useWidth<HTMLDivElement>()
  const [active, setActive] = useState<number | null>(null)

  const pad = { top: 12, right: 14, bottom: 24, left: 46 }
  const plotW = Math.max(0, width - pad.left - pad.right)
  const plotH = height - pad.top - pad.bottom

  if (points.length === 0) return <div ref={ref} style={{ height }} />

  const times = points.map((p) => new Date(p.date + 'T00:00:00').getTime())
  const t0 = times[0]
  const t1 = times[times.length - 1]
  const span = t1 - t0 || 1

  const values = points.map((p) => p.cumulative)
  const yMax = Math.max(0, ...values)
  const yMin = Math.min(0, ...values)
  const ticks = niceTicks(yMin, yMax)
  const domainMax = Math.max(yMax, ticks[ticks.length - 1] ?? yMax)
  const domainMin = Math.min(yMin, ticks[0] ?? yMin)
  const domain = domainMax - domainMin || 1

  const x = (i: number) =>
    pad.left + (points.length === 1 ? plotW / 2 : ((times[i] - t0) / span) * plotW)
  const y = (v: number) => pad.top + plotH - ((v - domainMin) / domain) * plotH

  const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i)},${y(p.cumulative)}`).join(' ')
  const base = y(Math.max(0, domainMin))
  const area = `${line} L${x(points.length - 1)},${base} L${x(0)},${base} Z`

  const nearest = (clientX: number) => {
    const el = ref.current
    if (!el) return null
    const rel = clientX - el.getBoundingClientRect().left
    let best = 0
    let bestD = Infinity
    for (let i = 0; i < points.length; i++) {
      const d = Math.abs(x(i) - rel)
      if (d < bestD) {
        bestD = d
        best = i
      }
    }
    return best
  }

  const a = active === null ? null : points[active]

  return (
    <div ref={ref} className="relative select-none" style={{ height }}>
      {width > 0 && (
        <svg
          width={width}
          height={height}
          role="img"
          aria-label={`Cumulative spend from ${formatDateLabel(points[0].date)} to ${formatDateLabel(points[points.length - 1].date)}`}
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
              e.preventDefault()
              const step = e.key === 'ArrowRight' ? 1 : -1
              setActive((p) => {
                const next = (p === null ? 0 : p + step)
                return Math.max(0, Math.min(points.length - 1, next))
              })
            }
            if (e.key === 'Escape') setActive(null)
          }}
          onBlur={() => setActive(null)}
          className="outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        >
          {/* Recessive chrome: solid hairlines, one step off the surface. */}
          {ticks.map((t) => (
            <g key={t}>
              <line
                x1={pad.left}
                x2={pad.left + plotW}
                y1={y(t)}
                y2={y(t)}
                stroke={VIZ.gridline}
                strokeWidth={1}
              />
              <text
                x={pad.left - 6}
                y={y(t) + 3}
                textAnchor="end"
                className="tnum"
                fontSize={10}
                fill={VIZ.muted}
              >
                {formatPaiseCompact(t)}
              </text>
            </g>
          ))}

          <path d={area} fill={VIZ.positive} fillOpacity={0.1} />
          <path
            d={line}
            fill="none"
            stroke={VIZ.positive}
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
          />

          {/* End marker: >=8px, with a 2px surface ring. */}
          <circle
            cx={x(points.length - 1)}
            cy={y(points[points.length - 1].cumulative)}
            r={4}
            fill={VIZ.positive}
            stroke={VIZ.surface}
            strokeWidth={2}
          />

          {a && active !== null && (
            <g>
              <line
                x1={x(active)}
                x2={x(active)}
                y1={pad.top}
                y2={pad.top + plotH}
                stroke={VIZ.baseline}
                strokeWidth={1}
              />
              <circle
                cx={x(active)}
                cy={y(a.cumulative)}
                r={4}
                fill={VIZ.positive}
                stroke={VIZ.surface}
                strokeWidth={2}
              />
            </g>
          )}

          <line
            x1={pad.left}
            x2={pad.left + plotW}
            y1={base}
            y2={base}
            stroke={VIZ.baseline}
            strokeWidth={1}
          />

          <text x={pad.left} y={height - 6} fontSize={10} fill={VIZ.muted}>
            {formatDateLabel(points[0].date)}
          </text>
          {points.length > 1 && (
            <text
              x={pad.left + plotW}
              y={height - 6}
              textAnchor="end"
              fontSize={10}
              fill={VIZ.muted}
            >
              {formatDateLabel(points[points.length - 1].date)}
            </text>
          )}

          {/* Transparent capture layer — the whole plot is the hit target. */}
          <rect
            x={pad.left}
            y={pad.top}
            width={plotW}
            height={plotH}
            fill="transparent"
            onPointerMove={(e) => setActive(nearest(e.clientX))}
            onPointerLeave={() => setActive(null)}
          />
        </svg>
      )}

      {a && active !== null && (
        <Tooltip
          x={x(active)}
          y={y(a.cumulative)}
          width={width}
          title={formatDateLabel(a.date)}
          rows={[
            { label: 'spent to date', value: formatPaise(a.cumulative), color: VIZ.positive },
            { label: 'that day', value: formatPaise(a.daily) },
          ]}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------- columns

/**
 * Monthly totals. One series, so one hue — except where a month nets negative
 * (a reversal), which takes the diverging red pole so the sign reads at a
 * glance instead of hiding in a downward bar.
 */
export function Columns({
  bars,
  height = 170,
  formatLabel,
}: {
  bars: { label: string; value: number; key: string }[]
  height?: number
  formatLabel: (k: string) => string
}) {
  const [ref, width] = useWidth<HTMLDivElement>()
  const [active, setActive] = useState<number | null>(null)

  const pad = { top: 18, right: 8, bottom: 26, left: 46 }
  const plotW = Math.max(0, width - pad.left - pad.right)
  const plotH = height - pad.top - pad.bottom

  if (bars.length === 0) return <div ref={ref} style={{ height }} />

  const values = bars.map((b) => b.value)
  const ticks = niceTicks(Math.min(0, ...values), Math.max(0, ...values))
  const domainMax = Math.max(0, ...values, ticks[ticks.length - 1] ?? 0)
  const domainMin = Math.min(0, ...values, ticks[0] ?? 0)
  const domain = domainMax - domainMin || 1

  const band = plotW / bars.length
  const barW = Math.min(BAR_MAX, Math.max(4, band - GAP * 2))
  const y = (v: number) => pad.top + plotH - ((v - domainMin) / domain) * plotH
  const zero = y(0)

  // Label the extreme only — a number on every cap is chaos and goes unread.
  const peak = values.reduce((best, v, i) => (Math.abs(v) > Math.abs(values[best]) ? i : best), 0)

  // Show every nth label when they would otherwise overlap. Overlapping ticks
  // are worse than fewer ticks: the reader can interpolate a gap, not a
  // collision. ~5.8px per character at font-size 10, plus breathing room.
  const widestLabel = Math.max(...bars.map((b) => formatLabel(b.key).length)) * 5.8 + 8
  const labelStep = Math.max(1, Math.ceil(widestLabel / Math.max(1, band)))
  const showLabel = (i: number) =>
    i % labelStep === 0 || i === bars.length - 1
      // Never let a kept label sit right next to the always-kept last one.
      ? !(i !== bars.length - 1 && bars.length - 1 - i < labelStep)
      : false

  return (
    <div ref={ref} className="relative select-none" style={{ height }}>
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label="Spend by month">
          {ticks.map((t) => (
            <g key={t}>
              <line
                x1={pad.left}
                x2={pad.left + plotW}
                y1={y(t)}
                y2={y(t)}
                stroke={VIZ.gridline}
                strokeWidth={1}
              />
              <text
                x={pad.left - 6}
                y={y(t) + 3}
                textAnchor="end"
                className="tnum"
                fontSize={10}
                fill={VIZ.muted}
              >
                {formatPaiseCompact(t)}
              </text>
            </g>
          ))}

          {bars.map((b, i) => {
            const cx = pad.left + band * i + band / 2
            const x = cx - barW / 2
            const h = Math.abs(y(b.value) - zero)
            const up = b.value >= 0
            const isActive = active === i
            return (
              <g key={b.key}>
                <path
                  d={barPath(x, up ? zero - h : zero, barW, h, up ? 'up' : 'down')}
                  fill={up ? VIZ.positive : VIZ.negative}
                  fillOpacity={isActive ? 0.82 : 1}
                />
                {i === peak && h > 10 && (
                  <text
                    // Clamped so the label never overflows the plot edge.
                    x={Math.min(Math.max(cx, pad.left + 18), pad.left + plotW - 18)}
                    y={up ? zero - h - 6 : zero + h + 12}
                    textAnchor="middle"
                    className="tnum"
                    fontSize={10}
                    fontWeight={600}
                    fill={VIZ.ink}
                  >
                    {formatPaiseCompact(b.value)}
                  </text>
                )}
                {showLabel(i) && (
                  <text
                    x={cx}
                    y={height - 8}
                    textAnchor="middle"
                    fontSize={10}
                    fill={VIZ.muted}
                  >
                    {formatLabel(b.key)}
                  </text>
                )}
                {/* Hit target spans the whole band and clears the 24px floor. */}
                <rect
                  x={cx - Math.max(HIT_MIN, band) / 2}
                  y={pad.top}
                  width={Math.max(HIT_MIN, band)}
                  height={plotH}
                  fill="transparent"
                  tabIndex={0}
                  role="button"
                  aria-label={`${formatLabel(b.key)}: ${formatPaise(b.value)}`}
                  onPointerEnter={() => setActive(i)}
                  onPointerLeave={() => setActive(null)}
                  onFocus={() => setActive(i)}
                  onBlur={() => setActive(null)}
                  className="outline-none focus-visible:stroke-2"
                />
              </g>
            )
          })}

          <line
            x1={pad.left}
            x2={pad.left + plotW}
            y1={zero}
            y2={zero}
            stroke={VIZ.baseline}
            strokeWidth={1}
          />
        </svg>
      )}

      {active !== null && (
        <Tooltip
          x={pad.left + band * active + band / 2}
          y={Math.min(y(bars[active].value), zero)}
          width={width}
          title={formatLabel(bars[active].key)}
          rows={[
            {
              label: 'spent',
              value: formatPaise(bars[active].value),
              color: bars[active].value >= 0 ? VIZ.positive : VIZ.negative,
            },
          ]}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------- bar list

export interface BarRow {
  name: string
  total: number
  isOther?: boolean
}

/**
 * Ranked magnitude over nominal categories, so every bar is one hue — colouring
 * each bar darker-where-bigger would double-encode the length it already shows.
 *
 * A zero line placed by the domain lets a net-negative row (a reversal) grow
 * left in the diverging red pole, rather than faking it as a short blue bar.
 */
export function BarList({
  rows,
  total,
  unitLabel = 'of total',
}: {
  rows: BarRow[]
  total: number
  unitLabel?: string
}) {
  const [active, setActive] = useState<string | null>(null)

  const max = Math.max(0, ...rows.map((r) => r.total))
  const min = Math.min(0, ...rows.map((r) => r.total))
  const span = max - min || 1
  const zeroPct = (-min / span) * 100

  return (
    <ul className="space-y-2.5">
      {rows.map((r) => {
        const widthPct = (Math.abs(r.total) / span) * 100
        const negative = r.total < 0
        const isActive = active === r.name
        const share = total !== 0 ? (r.total / total) * 100 : 0

        return (
          <li
            key={r.name}
            tabIndex={0}
            onPointerEnter={() => setActive(r.name)}
            onPointerLeave={() => setActive(null)}
            onFocus={() => setActive(r.name)}
            onBlur={() => setActive(null)}
            // The whole row is the hit target, comfortably past the 24px floor.
            className="cursor-default rounded-md outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          >
            <div className="flex items-baseline justify-between gap-3">
              <span className="min-w-0 flex-1 truncate text-sm">{r.name}</span>
              <span className="tnum shrink-0 text-sm font-medium">{formatPaise(r.total)}</span>
            </div>
            <div className="relative mt-1 h-2.5 w-full rounded-full bg-ground">
              <div
                className="absolute top-0 h-full transition-opacity"
                style={{
                  left: negative ? `${zeroPct - widthPct}%` : `${zeroPct}%`,
                  width: `${widthPct}%`,
                  background: r.isOther ? VIZ.other : negative ? VIZ.negative : VIZ.positive,
                  // 4px rounded data-end, square at the baseline.
                  borderRadius: negative ? '4px 0 0 4px' : '0 4px 4px 0',
                  opacity: isActive ? 0.82 : 1,
                }}
              />
            </div>
            {isActive && (
              <div className="mt-0.5 text-xs text-muted">
                {share >= 0 ? '' : '−'}
                {Math.abs(share).toFixed(1)}% {unitLabel}
              </div>
            )}
          </li>
        )
      })}
    </ul>
  )
}

// ------------------------------------------------------------ stacked bar

/**
 * Part-to-whole across a handful of classes — which account actually paid.
 *
 * Categorical hues in fixed slot order, capped so at most six segments share
 * the screen; the tail folds into a grey "Other" rather than a generated ninth
 * hue. Segments are separated by a 2px surface gap, never a stroke.
 *
 * Interior segments have no free end, so they carry no inline label; the legend
 * pairs each hue with its name and value, which is also the relief for the
 * lighter slots that sit below 3:1 on this surface.
 */
export function StackedBar({ rows }: { rows: BarRow[] }) {
  const [active, setActive] = useState<string | null>(null)

  // A stack only reads as part-to-whole when every part is positive.
  const parts = rows.filter((r) => r.total > 0)
  const total = parts.reduce((a, r) => a + r.total, 0)
  if (total === 0) return null

  const colorFor = (r: BarRow, i: number) =>
    r.isOther ? VIZ.other : VIZ.series[i % VIZ.series.length]

  return (
    <div>
      <div className="flex h-7 w-full items-stretch overflow-hidden rounded-md" style={{ gap: GAP }}>
        {parts.map((r, i) => (
          <div
            key={r.name}
            tabIndex={0}
            role="button"
            aria-label={`${r.name}: ${formatPaise(r.total)}, ${((r.total / total) * 100).toFixed(1)} percent`}
            onPointerEnter={() => setActive(r.name)}
            onPointerLeave={() => setActive(null)}
            onFocus={() => setActive(r.name)}
            onBlur={() => setActive(null)}
            style={{
              width: `${(r.total / total) * 100}%`,
              background: colorFor(r, i),
              opacity: active && active !== r.name ? 0.55 : 1,
            }}
            className="min-w-1 outline-none transition-opacity first:rounded-l-md last:rounded-r-md focus-visible:ring-2 focus-visible:ring-accent/40"
          />
        ))}
      </div>

      <Legend
        items={parts.map((r, i) => ({
          name: r.name,
          color: colorFor(r, i),
          value: `${((r.total / total) * 100).toFixed(0)}%`,
        }))}
      />

      {active && (
        <p className="mt-2 text-xs text-muted">
          <span className="tnum font-medium text-ink">
            {formatPaise(parts.find((p) => p.name === active)!.total)}
          </span>{' '}
          from {active}
        </p>
      )}
    </div>
  )
}
