import { useLayoutEffect, useRef, useState } from 'react'

/**
 * Chart tokens.
 *
 * The categorical slots are used in this fixed order and never cycled — the
 * order is what keeps adjacent pairs colourblind-separable, so reordering or
 * appending a ninth hue would break it. Validated against this app's card
 * surface (#ffffff): every hard gate passes; aqua, yellow and magenta sit below
 * 3:1 contrast, which is why every chart here ships visible labels and a table
 * view rather than relying on the fill alone.
 *
 * The app is light-only, so one set of values. A dark theme would re-step these
 * against the dark surface here, not flip them.
 */
export const VIZ = {
  surface: '#ffffff',
  gridline: '#e5e7eb',
  baseline: '#c3c2b7',
  muted: '#6b7280',
  ink: '#14181f',
  /** Fixed categorical order: blue, orange, aqua, yellow, magenta. */
  series: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4'],
  other: '#9ca3af',
  /** Diverging poles for net values that can fall below zero (reversals). */
  positive: '#2a78d6',
  negative: '#e34948',
} as const

export const BAR_MAX = 24 // px — never fill the band; the leftover is air
export const RADIUS = 4 // px rounded data-end
export const GAP = 2 // px surface gap between touching marks
export const HIT_MIN = 24 // px minimum pointer target

// ---------------------------------------------------------------- layout

/** Tracks a container's width so SVG charts can be responsive without a lib. */
export function useWidth<T extends HTMLElement>() {
  const ref = useRef<T | null>(null)
  const [width, setWidth] = useState(0)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    setWidth(el.clientWidth)
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) setWidth(e.contentRect.width)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  return [ref, width] as const
}

/**
 * A rectangle with its data-end rounded and its baseline end square, per the
 * mark spec. `dir` is the direction the bar grows in.
 */
export function barPath(
  x: number,
  y: number,
  w: number,
  h: number,
  dir: 'up' | 'down' | 'right',
): string {
  const r = Math.max(0, Math.min(RADIUS, dir === 'right' ? w / 2 : h / 2))
  if (dir === 'right') {
    return `M${x},${y} H${x + w - r} A${r},${r} 0 0 1 ${x + w},${y + r} V${y + h - r} A${r},${r} 0 0 1 ${x + w - r},${y + h} H${x} Z`
  }
  if (dir === 'up') {
    // y is the top of the bar, y + h the baseline.
    return `M${x},${y + h} V${y + r} A${r},${r} 0 0 1 ${x + r},${y} H${x + w - r} A${r},${r} 0 0 1 ${x + w},${y + r} V${y + h} Z`
  }
  // down: y is the baseline, y + h the bottom (rounded) end.
  return `M${x},${y} V${y + h - r} A${r},${r} 0 0 0 ${x + r},${y + h} H${x + w - r} A${r},${r} 0 0 0 ${x + w},${y + h - r} V${y} Z`
}

/** Clean axis ticks — 0 / 1L / 2L, never 1.8333L. */
export function niceTicks(min: number, max: number, count = 4): number[] {
  if (max === min) return [min]
  const raw = (max - min) / count
  const mag = Math.pow(10, Math.floor(Math.log10(Math.abs(raw))))
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? mag * 10
  const start = Math.floor(min / step) * step
  const ticks: number[] = []
  for (let v = start; v <= max + step / 2; v += step) ticks.push(v)
  return ticks
}
