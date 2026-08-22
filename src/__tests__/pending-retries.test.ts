import { describe, it, expect } from 'vitest'
import {
  shouldSendAlert,
  toPendingRetryView,
  classifyTelegramSendError,
  ALERT_THRESHOLD_S,
  reAlertIntervalS,
  retryBackoffS,
  shouldRetryNow,
  MAX_BACKOFF_S,
} from '../pending-retries.js'

describe('shouldSendAlert', () => {
  const firstAttempt = 1_000_000
  const threshold = 60 * 60 * 1000 // 1 hour

  it('returns false when no time has passed', () => {
    expect(shouldSendAlert(firstAttempt, firstAttempt, null, threshold)).toBe(false)
  })

  it('returns false while the waiting window is below the threshold', () => {
    expect(shouldSendAlert(firstAttempt + threshold / 2, firstAttempt, null, threshold)).toBe(false)
  })

  it('returns false exactly at the threshold (strict >)', () => {
    expect(shouldSendAlert(firstAttempt + threshold, firstAttempt, null, threshold)).toBe(false)
  })

  it('returns true once the waiting window exceeds the threshold', () => {
    expect(shouldSendAlert(firstAttempt + threshold + 1, firstAttempt, null, threshold)).toBe(true)
  })

  it('returns false if an alert was sent and the re-alert window has not elapsed', () => {
    // Re-alert interval for age < 6h is 1h (3600s). Alert was sent 100s ago -> suppressed.
    const alertSentAt = firstAttempt + ALERT_THRESHOLD_S + 100
    const now = alertSentAt + 100  // 100s after alert, well within the 1h re-alert window
    expect(shouldSendAlert(now, firstAttempt, alertSentAt)).toBe(false)
  })

  it('returns true when the re-alert interval has elapsed since last alert (card c87b198a)', () => {
    // age < 6h -> re-alert every 1h. Alert sent 3601s ago -> re-alert due.
    const alertSentAt = firstAttempt + ALERT_THRESHOLD_S + 1
    const now = alertSentAt + 3601  // just over 1h since the alert
    expect(shouldSendAlert(now, firstAttempt, alertSentAt)).toBe(true)
  })

  it('uses a 6h re-alert interval when age is between 6h and 24h', () => {
    const ageS = 12 * 3600  // 12h age -> reAlertIntervalS = 6h
    // Alert was sent 5h ago (< 6h interval) -> still suppressed
    const alertSentAt = firstAttempt + ageS - 5 * 3600  // 5h before now
    const now = firstAttempt + ageS
    expect(shouldSendAlert(now, firstAttempt, alertSentAt)).toBe(false)
    // Alert was sent 6h+1s ago -> re-alert due
    const olderAlertSentAt = firstAttempt + ageS - (6 * 3600 + 1)
    expect(shouldSendAlert(now, firstAttempt, olderAlertSentAt)).toBe(true)
  })

  it('uses a 24h re-alert interval when age exceeds 24h', () => {
    const ageS = 30 * 3600  // 30h
    const alertSentAt = firstAttempt + ALERT_THRESHOLD_S + 1
    const now = firstAttempt + ageS
    // 23h since alert (< 24h interval) -> suppressed
    const twentyThreeHoursLater = alertSentAt + 23 * 3600
    if (twentyThreeHoursLater < now) {
      expect(shouldSendAlert(twentyThreeHoursLater, firstAttempt, alertSentAt)).toBe(false)
    }
    // 25h since alert -> re-alert due
    const twentyFiveHoursLater = alertSentAt + 25 * 3600
    if (twentyFiveHoursLater <= firstAttempt + ageS + 3600) {
      expect(shouldSendAlert(twentyFiveHoursLater, firstAttempt, alertSentAt)).toBe(true)
    }
  })

  it('uses the default threshold (1 hour) when not supplied', () => {
    expect(shouldSendAlert(firstAttempt + ALERT_THRESHOLD_S + 1, firstAttempt, null)).toBe(true)
    expect(shouldSendAlert(firstAttempt + ALERT_THRESHOLD_S - 1, firstAttempt, null)).toBe(false)
  })

  it('returns false if firstAttempt is zero / non-positive (corrupt row)', () => {
    expect(shouldSendAlert(Date.now(), 0, null, threshold)).toBe(false)
    expect(shouldSendAlert(Date.now(), -1, null, threshold)).toBe(false)
  })

  it('returns false if now < firstAttempt (clock skew or bad input)', () => {
    expect(shouldSendAlert(firstAttempt - 1000, firstAttempt, null, threshold)).toBe(false)
  })

  it('returns false on non-finite inputs', () => {
    expect(shouldSendAlert(NaN, firstAttempt, null, threshold)).toBe(false)
    expect(shouldSendAlert(firstAttempt + threshold + 1, NaN, null, threshold)).toBe(false)
  })
})

describe('toPendingRetryView', () => {
  const baseRow = {
    id: 42,
    task_name: 'morning-summary',
    agent_name: 'main',
    first_attempt: 1_000_000,
    last_attempt: 1_000_500,
    attempt_count: 5,
    last_reason: 'busy',
    alert_sent_at: null as number | null,
  }

  it('maps snake_case DB fields to camelCase UI view', () => {
    const view = toPendingRetryView(baseRow, 1_001_000)
    expect(view).toMatchObject({
      id: 42,
      taskName: 'morning-summary',
      agentName: 'main',
      firstAttempt: 1_000_000,
      lastAttempt: 1_000_500,
      attemptCount: 5,
      lastReason: 'busy',
      alertSentAt: null,
    })
  })

  it('derives ageMs from SECOND-valued timestamps, clamped at zero', () => {
    // The row and `now` are seconds (what the sweep writes); ageMs stays the
    // millisecond response contract the dashboard renders. Reading the row as
    // ms is what made the live API report 20649 days for every row.
    expect(toPendingRetryView(baseRow, 1_000_000 + 12345).ageMs).toBe(12_345_000)
    // Negative age (clock skew): clamp to 0
    expect(toPendingRetryView(baseRow, 999_000).ageMs).toBe(0)
  })

  it('normalises a legacy millisecond first_attempt instead of reading it as a future date', () => {
    // Rows written before the sweep migration hold ms. Untreated, now - first
    // is hugely negative -> clamps to 0 -> "not old enough" -> never alerts.
    // That is a silent no-alert, the very failure this module guards.
    const nowS = 1_800_000_000
    const legacyMsRow = { ...baseRow, first_attempt: (nowS - 7200) * 1000 }

    const view = toPendingRetryView(legacyMsRow, nowS)

    expect(view.ageMs).toBe(7_200_000)
    expect(view.alertDue).toBe(true)
  })

  it('sets alertDue=true once past the threshold and no alert yet', () => {
    const view = toPendingRetryView(baseRow, 1_000_000 + ALERT_THRESHOLD_S + 1)
    expect(view.alertDue).toBe(true)
  })

  it('sets alertDue=false if an alert was sent and re-alert window has not elapsed', () => {
    // age = 2*ALERT_THRESHOLD_S = 7200s < 6h -> reAlertIntervalS = 3600.
    // Alert was sent 3500s ago (< 3600s) -> still suppressed.
    const alertSentAt = 1_000_000 + ALERT_THRESHOLD_S + 100
    const view = toPendingRetryView(
      { ...baseRow, alert_sent_at: alertSentAt },
      1_000_000 + 2 * ALERT_THRESHOLD_S,  // now - alertSentAt = 2*3600 - 3700 = 3500 < 3600
    )
    expect(view.alertDue).toBe(false)
  })

  it('sets alertDue=true when the re-alert interval has elapsed (card c87b198a)', () => {
    // age ~= 6500s < 6h -> reAlertIntervalS = 3600. Alert was sent 3700s ago -> due.
    const alertSentAt = 1_000_000 + ALERT_THRESHOLD_S + 100
    const now = alertSentAt + 3700  // 3700s after the alert (> 1h re-alert interval)
    const view = toPendingRetryView({ ...baseRow, alert_sent_at: alertSentAt }, now)
    expect(view.alertDue).toBe(true)
  })

  it('honors a custom threshold', () => {
    const view = toPendingRetryView(baseRow, 1_000_100, 50)
    expect(view.alertDue).toBe(true)
    const viewUnder = toPendingRetryView(baseRow, 1_000_100, 200)
    expect(viewUnder.alertDue).toBe(false)
  })
})

describe('classifyTelegramSendError', () => {
  it('treats a bare network error (no HTTP status) as transient', () => {
    expect(classifyTelegramSendError('fetch failed')).toBe('transient')
    expect(classifyTelegramSendError('TypeError: fetch failed')).toBe('transient')
  })

  it('treats 429 (rate limited) as transient', () => {
    expect(classifyTelegramSendError('Telegram API 429: Too Many Requests')).toBe('transient')
  })

  it('treats 5xx as transient', () => {
    expect(classifyTelegramSendError('Telegram API 500: Internal Server Error')).toBe('transient')
    expect(classifyTelegramSendError('Telegram API 502: Bad Gateway')).toBe('transient')
  })

  it('treats 400 (bad chat_id) as permanent', () => {
    expect(classifyTelegramSendError('Telegram API 400: Bad Request: chat not found')).toBe('permanent')
  })

  it('treats 401/403/404 (bad or blocked token) as permanent', () => {
    expect(classifyTelegramSendError('Telegram API 401: Unauthorized')).toBe('permanent')
    expect(classifyTelegramSendError('Telegram API 403: Forbidden: bot was blocked by the user')).toBe('permanent')
    expect(classifyTelegramSendError('Telegram API 404: Not Found')).toBe('permanent')
  })
})

describe('reAlertIntervalS (card c87b198a: escalating re-alert schedule)', () => {
  it('returns 1h for age < 6h', () => {
    expect(reAlertIntervalS(0)).toBe(3600)
    expect(reAlertIntervalS(3600)).toBe(3600)
    expect(reAlertIntervalS(6 * 3600 - 1)).toBe(3600)
  })

  it('returns 6h for age between 6h and 24h', () => {
    expect(reAlertIntervalS(6 * 3600)).toBe(6 * 3600)
    expect(reAlertIntervalS(12 * 3600)).toBe(6 * 3600)
    expect(reAlertIntervalS(24 * 3600 - 1)).toBe(6 * 3600)
  })

  it('returns 24h for age >= 24h', () => {
    expect(reAlertIntervalS(24 * 3600)).toBe(24 * 3600)
    expect(reAlertIntervalS(61 * 3600)).toBe(24 * 3600)
  })
})

describe('retryBackoffS + shouldRetryNow (card c87b198a: exponential backoff, cap MAX_BACKOFF_S)', () => {
  it('starts at 60s for attempt 0', () => {
    expect(retryBackoffS(0)).toBe(60)
  })

  it('doubles every 3 attempts', () => {
    expect(retryBackoffS(0)).toBe(60)
    expect(retryBackoffS(3)).toBe(120)
    expect(retryBackoffS(6)).toBe(240)
    expect(retryBackoffS(9)).toBe(480)
  })

  it('caps at MAX_BACKOFF_S', () => {
    expect(retryBackoffS(100)).toBe(MAX_BACKOFF_S)
    expect(retryBackoffS(9)).toBeLessThanOrEqual(MAX_BACKOFF_S)
    expect(retryBackoffS(12)).toBe(MAX_BACKOFF_S)
  })

  it('MAX_BACKOFF_S is at most 10 minutes', () => {
    expect(MAX_BACKOFF_S).toBeLessThanOrEqual(10 * 60)
  })

  it('shouldRetryNow returns true when backoff has elapsed', () => {
    const lastAttempt = 1_000_000
    const attemptCount = 0  // backoff = 60s
    expect(shouldRetryNow(lastAttempt, attemptCount, lastAttempt + 60)).toBe(true)
    expect(shouldRetryNow(lastAttempt, attemptCount, lastAttempt + 61)).toBe(true)
  })

  it('shouldRetryNow returns false before the backoff elapses', () => {
    const lastAttempt = 1_000_000
    const attemptCount = 3  // backoff = 120s
    expect(shouldRetryNow(lastAttempt, attemptCount, lastAttempt + 119)).toBe(false)
    expect(shouldRetryNow(lastAttempt, attemptCount, lastAttempt + 120)).toBe(true)
  })

  it('shouldRetryNow always returns true once MAX_BACKOFF_S has elapsed', () => {
    const lastAttempt = 1_000_000
    expect(shouldRetryNow(lastAttempt, 999, lastAttempt + MAX_BACKOFF_S)).toBe(true)
  })
})
