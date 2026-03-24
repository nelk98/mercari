export const DEFAULT_PORT = 2999
export const DEFAULT_INTERVAL_MIN_MS = 20000
export const DEFAULT_INTERVAL_MAX_MS = 30000
export const DEFAULT_FETCH_LIMIT = 18
export const DEFAULT_WIDGET_FETCH_LIMIT = 3

export const SourceState = Object.freeze({
  ENABLED: 1,
  DISABLED: 0,
})

export const ApiErrorCode = Object.freeze({
  INVALID_INPUT: 'INVALID_INPUT',
  NOT_FOUND: 'NOT_FOUND',
  SCRAPE_FAILED: 'SCRAPE_FAILED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
})

export const nowIso = () => new Date().toISOString()

export const clamp = (value, min, max) => Math.max(min, Math.min(max, value))
