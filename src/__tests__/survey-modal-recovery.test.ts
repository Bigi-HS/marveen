import { describe, it, expect } from 'vitest'
import {
  decideSurveyModalRecovery,
  DEFAULT_SURVEY_MODAL_RECOVERY_THRESHOLDS,
  CLEAN_SURVEY_MODAL_RECOVERY_STATE,
  type SurveyModalSignal,
} from '../web/survey-modal-recovery.js'

const T = DEFAULT_SURVEY_MODAL_RECOVERY_THRESHOLDS
const t0 = Date.now()

describe('decideSurveyModalRecovery -- two-stage gate', () => {
  it('FN-guard: modal present + inbox stuck → gate passes over threshold → dismiss', () => {
    const signal: SurveyModalSignal = { onFeedbackModal: true, inboxStuck: true }
    let state = CLEAN_SURVEY_MODAL_RECOVERY_STATE

    // Tick 1: gate passes, counter increments
    let d = decideSurveyModalRecovery(signal, state, t0, T)
    expect(d.action).toBe('none') // Not yet confirmed (need 2 ticks)
    state = d.next

    // Tick 2: gate passes again, counter hits threshold
    d = decideSurveyModalRecovery(signal, state, t0 + 1000, T)
    expect(d.action).toBe('dismiss') // Gate confirmed, action triggered
    expect(d.next.lastDismissalTs).toBe(t0 + 1000)
    expect(d.next.dismissalCount).toBe(1)
  })

  it('FP-guard: modal present but inbox NOT stuck → gate still passes (inbox not required)', () => {
    // inbox-stuck is no longer required. A modal visible for 2 consecutive ticks is
    // sufficient to dismiss (claudia-case: heartbeat-only block, no pending inter-agent msgs).
    const signal: SurveyModalSignal = { onFeedbackModal: true, inboxStuck: false }

    // Tick 1: gate passes (counter increments), no action yet
    let d = decideSurveyModalRecovery(signal, CLEAN_SURVEY_MODAL_RECOVERY_STATE, t0, T)
    expect(d.action).toBe('none')
    expect(d.next.consecutiveDetections).toBe(1) // Counter increments

    // Tick 2: gate passes again, confirmation threshold met → dismiss
    d = decideSurveyModalRecovery(signal, d.next, t0 + 1000, T)
    expect(d.action).toBe('dismiss')
  })

  it('FP-guard: modal NOT visible → no dismiss', () => {
    const signal: SurveyModalSignal = { onFeedbackModal: false, inboxStuck: true }
    const d = decideSurveyModalRecovery(signal, CLEAN_SURVEY_MODAL_RECOVERY_STATE, t0, T)
    expect(d.action).toBe('none')
    expect(d.next.consecutiveDetections).toBe(0)
  })

  it('Both gates false → no dismiss', () => {
    const signal: SurveyModalSignal = { onFeedbackModal: false, inboxStuck: false }
    const d = decideSurveyModalRecovery(signal, CLEAN_SURVEY_MODAL_RECOVERY_STATE, t0, T)
    expect(d.action).toBe('none')
    expect(d.next.consecutiveDetections).toBe(0)
  })
})

describe('decideSurveyModalRecovery -- cooldown / cap', () => {
  it('Cooldown blocks re-dismissal within 5 min', () => {
    const signal: SurveyModalSignal = { onFeedbackModal: true, inboxStuck: true }

    // First dismissal
    let state = { ...CLEAN_SURVEY_MODAL_RECOVERY_STATE, consecutiveDetections: 2 }
    let d = decideSurveyModalRecovery(signal, state, t0, T)
    expect(d.action).toBe('dismiss')
    state = d.next

    // Immediately after dismissal, gate passes but cooldown blocks
    d = decideSurveyModalRecovery(signal, state, t0 + 1000, T)
    expect(d.action).toBe('none')
    expect(d.reason).toContain('cooldown')

    // After cooldown expires, dismiss again
    d = decideSurveyModalRecovery(signal, state, t0 + 5 * 60 * 1000 + 1000, T)
    expect(d.action).toBe('dismiss') // (counter will reset and re-confirm over 2 ticks normally)
  })

  it('Modal disappearance resets confirmation counter', () => {
    const signal: SurveyModalSignal = { onFeedbackModal: true, inboxStuck: true }
    let state = CLEAN_SURVEY_MODAL_RECOVERY_STATE

    // Tick 1: gate passes
    let d = decideSurveyModalRecovery(signal, state, t0, T)
    expect(d.next.consecutiveDetections).toBe(1)
    state = d.next

    // Modal disappears
    const signalNoModal: SurveyModalSignal = { onFeedbackModal: false, inboxStuck: true }
    d = decideSurveyModalRecovery(signalNoModal, state, t0 + 1000, T)
    expect(d.next.consecutiveDetections).toBe(0) // Counter reset
    state = d.next

    // Modal reappears; must confirm again
    d = decideSurveyModalRecovery(signal, state, t0 + 2000, T)
    expect(d.action).toBe('none')
    expect(d.next.consecutiveDetections).toBe(1)
  })
})

describe('decideSurveyModalRecovery -- session tracking', () => {
  it('Dismissal count increments on each action', () => {
    const signal: SurveyModalSignal = { onFeedbackModal: true, inboxStuck: true }

    // First dismissal
    let state = { ...CLEAN_SURVEY_MODAL_RECOVERY_STATE, consecutiveDetections: 2 }
    let d = decideSurveyModalRecovery(signal, state, t0, T)
    expect(d.next.dismissalCount).toBe(1)
    state = d.next

    // Wait past the cooldown (first dismissal was at t0) + re-confirm.
    // lastDismissalTs stays t0 from the prior dismissal; now is 6 min later
    // (> 5 min cooldown), so the gate re-fires.
    state = { ...state, consecutiveDetections: 2 }
    d = decideSurveyModalRecovery(signal, state, t0 + 6 * 60 * 1000, T)
    expect(d.action).toBe('dismiss')
    expect(d.next.dismissalCount).toBe(2)
  })

  it('No action does not increment dismissal count', () => {
    // Modal visible for only 1 tick → pending, count stays 0
    const signal: SurveyModalSignal = { onFeedbackModal: true, inboxStuck: false }
    const d = decideSurveyModalRecovery(signal, CLEAN_SURVEY_MODAL_RECOVERY_STATE, t0, T)
    expect(d.action).toBe('none')
    expect(d.next.dismissalCount).toBe(0) // No dismiss yet (1/2 ticks)
  })
})
