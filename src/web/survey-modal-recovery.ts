// Survey modal auto-dismiss recovery (fce12f45).
// When Claude Code's session-feedback modal appears and blocks input, auto-dismiss
// by sending keystroke '0'. Two-stage gate: pane-present + inbox-stuck confirmation.

export interface SurveyModalSignal {
  onFeedbackModal: boolean // Modal visible in pane tail (detectsFeedbackModal)
  inboxStuck: boolean      // Pending messages >threshold age
}

export interface SurveyModalRecoveryState {
  consecutiveDetections: number // Consecutive ticks modal was detected
  lastDismissalTs: number | null // Timestamp of last dismissal action (cooldown guard)
  dismissalCount: number         // Total dismissals in this session (observability)
}

export interface SurveyModalRecoveryThresholds {
  confirmationTicks: number        // Ticks with (modal+stuck) before dismissing (gate threshold)
  cooldownMs: number               // Prevent rapid re-dismissal
}

export const DEFAULT_SURVEY_MODAL_RECOVERY_THRESHOLDS: SurveyModalRecoveryThresholds = {
  confirmationTicks: 2,      // Modal + stuck confirmed over 2 ticks = gate passes
  cooldownMs: 5 * 60 * 1000, // 5 min cooldown between dismissals
}

export const CLEAN_SURVEY_MODAL_RECOVERY_STATE: SurveyModalRecoveryState = {
  consecutiveDetections: 0,
  lastDismissalTs: null,
  dismissalCount: 0,
}

export type SurveyModalRecoveryAction = 'dismiss' | 'none'

export interface SurveyModalRecoveryDecision {
  action: SurveyModalRecoveryAction
  reason: string
  next: SurveyModalRecoveryState
}

// Two-stage gate for survey-modal dismissal:
// 1. DETECTION: modal visible in pane tail + inbox has pending messages
// 2. CONFIRMATION: gate triggered only if BOTH conditions persist for confirmationTicks
// 3. COOLDOWN: prevent dismissal spam (5 min between dismissals)
// 4. ACTION: send keystroke '0' to dismiss the modal
//
// Returns decision + updated state. Caller must apply state update and (on 'dismiss')
// send keystroke via tmux.
export function decideSurveyModalRecovery(
  signal: SurveyModalSignal,
  state: SurveyModalRecoveryState,
  now: number,
  thresholds: SurveyModalRecoveryThresholds,
): SurveyModalRecoveryDecision {
  // Gate 1: Modal visibility alone is sufficient to increment detection count.
  // inbox-stuck is logged for observability but no longer gates dismissal:
  // a modal visible for 2+ consecutive ticks is a blocker regardless of inbox state
  // (claudia-case: heartbeat-only block with no pending inter-agent messages).
  const gatePass = signal.onFeedbackModal
  const newConsecutive = gatePass ? state.consecutiveDetections + 1 : 0

  // Gate 2: Cooldown check (prevent dismissal spam)
  const cooldownActive =
    state.lastDismissalTs !== null &&
    now - state.lastDismissalTs < thresholds.cooldownMs

  // Decision logic
  let action: SurveyModalRecoveryAction = 'none'
  let reason = ''

  if (!signal.onFeedbackModal) {
    // Modal gone; reset counter
    reason = 'modal not visible'
  } else if (cooldownActive) {
    // Gate passed but cooldown active
    reason = `cooldown active (${Math.round((thresholds.cooldownMs - (now - state.lastDismissalTs!)) / 1000)}s remaining)`
  } else if (newConsecutive >= thresholds.confirmationTicks) {
    // Gate passed + cooldown clear + confirmation threshold met
    action = 'dismiss'
    reason = `gate confirmed (${newConsecutive}/${thresholds.confirmationTicks} ticks)`
  } else {
    // Gate passed but not yet confirmed
    reason = `confirmation pending (${newConsecutive}/${thresholds.confirmationTicks})`
  }

  const next: SurveyModalRecoveryState = {
    consecutiveDetections: newConsecutive,
    lastDismissalTs: action === 'dismiss' ? now : state.lastDismissalTs,
    dismissalCount: action === 'dismiss' ? state.dismissalCount + 1 : state.dismissalCount,
  }

  return { action, reason, next }
}
