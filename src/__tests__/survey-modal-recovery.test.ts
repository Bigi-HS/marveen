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

  it('FP-guard: modal present but inbox NOT stuck → no dismiss', () => {
    const signal: SurveyModalSignal = { onFeedbackModal: true, inboxStuck: false }
    const d = decideSurveyModalRecovery(signal, CLEAN_SURVEY_MODAL_RECOVERY_STATE, t0, T)
    expect(d.action).toBe('none')
    expect(d.next.consecutiveDetections).toBe(0) // Counter reset because one gate condition failed
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

    // Wait for cooldown + re-confirm
    state = { ...state, consecutiveDetections: 2, lastDismissalTs: t0 + 6 * 60 * 1000 - 1000 }
    d = decideSurveyModalRecovery(signal, state, t0 + 6 * 60 * 1000, T)
    expect(d.action).toBe('dismiss')
    expect(d.next.dismissalCount).toBe(2)
  })

  it('No action does not increment dismissal count', () => {
    const signal: SurveyModalSignal = { onFeedbackModal: true, inboxStuck: false }
    const d = decideSurveyModalRecovery(signal, CLEAN_SURVEY_MODAL_RECOVERY_STATE, t0, T)
    expect(d.action).toBe('none')
    expect(d.next.dismissalCount).toBe(0)
  })
})
