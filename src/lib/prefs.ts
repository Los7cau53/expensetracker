import { useCallback, useEffect, useState } from 'react'

/**
 * UI preferences (last-used project, filter state) live in localStorage, not
 * IndexedDB: they are conveniences, they are per-device by nature, and losing
 * them costs nothing. Ledger data never goes here.
 */
const PREFIX = 'ce.pref.'

export function readPref<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(PREFIX + key)
    return raw === null ? fallback : (JSON.parse(raw) as T)
  } catch {
    return fallback
  }
}

export function writePref<T>(key: string, value: T): void {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value))
  } catch {
    // Private browsing can throw on write; a lost preference is not worth surfacing.
  }
}

export function usePref<T>(key: string, fallback: T) {
  const [value, setValue] = useState<T>(() => readPref(key, fallback))
  useEffect(() => writePref(key, value), [key, value])
  const reset = useCallback(() => setValue(fallback), [fallback])
  return [value, setValue, reset] as const
}
