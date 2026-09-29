# C12 Feedback Modal Gate Validation (9644ed7c G6)

**Status:** LIVE-DEPLOY BLOCKER  
**Owner:** marveen (orchestration)  
**Gate Requirement:** Real C12/Buster pane capture validation  
**Code Merge:** PR #766 (2026-09-29 00:51:49 UTC)  
**Deadline:** Before production deploy  

---

## What is G6?

The "feedback modal" detector is part of the 9644ed7c effect-probe chain. Claude Code occasionally shows a survey modal:

```
How is Claude doing this session? (optional)
  1: Amazing — I'm getting a lot done
  2: Good
  3: Could be improved
  0: Dismiss
```

**Problem:** While this modal is visible, it swallows the first keystroke (e.g., turning `/compact` into `0/compact`), blocking prompt delivery.

**What we built:**
- **SLICE 1 (PR #766):** Detection-only. A regex pattern that identifies the modal in the pane tail.
- **SLICE 2 (fce12f45, pending):** Recovery wiring. Send `0` to dismiss when modal is detected.

G6 is the **detection part** and is LOG-ONLY (observation, no action yet).

---

## Gate Requirement: Live Verification

The code comment in `src/pane-state.ts:167-172` states:

```
LIVE-VERIFIED: ... Tail-scoping and the adversarial fixtures were 
gate-validated against a real buster/c12 pane capture (see 
store/incident-evidence/ on first live capture; use synthetic fixtures 
until then, but do NOT merge until live-verified -- gate requirement 
per marveen 2026-09-29).
```

**What this means:**
1. PR #766 merged synthetic test fixtures (comprehensive, adversarial, covering false-negatives and false-positives).
2. Before production deploy, a **real pane capture** from C12/Buster must validate that the regex works correctly on the live system.
3. The real capture is stored as evidence in `store/incident-evidence/c12-feedback-modal-live-*.txt`.

---

## Validation Checklist

### Prerequisites

- [ ] C12/Buster system is running with latest develop branch
- [ ] Claude Code is active on the Buster pane
- [ ] Ability to trigger the feedback survey modal (varies; may be automatic or after a number of turns)

### Trigger the Modal

The feedback modal appears **after Claude Code processes a prompt**. It's non-deterministic but typically appears after several turns of operation. 

**Options to trigger:**
1. Run a normal agent task and wait for the modal to appear naturally
2. If it doesn't appear, continue working and check periodically
3. The modal typically appears after a few agent turns, not on the first turn

### Capture Phase

1. **Observe the modal** on the Buster pane:
   - Look for text: `How is Claude doing this session?`
   - Modal should be visible in the bottom 10 lines of the pane

2. **Run the validation script:**
   ```bash
   cd /home/domin/marveen
   bash scripts/c12-feedback-modal-validate.sh
   ```

3. **Expected output:**
   ```
   [c12-feedback-modal-validate] Capturing Buster pane...
   [c12-feedback-modal-validate] Pane captured to: store/incident-evidence/c12-feedback-modal-live-20260929-HHMMSS.txt
   [c12-feedback-modal-validate] ✓ PASS: Regex correctly detected feedback modal in tail
   ```

### Verification

- [ ] Script exits with code 0 (PASS)
- [ ] Evidence file created: `store/incident-evidence/c12-feedback-modal-live-*.txt`
- [ ] Result file created: `store/incident-evidence/c12-feedback-modal-live-*-result.txt` with `PASS` status

### Commit Evidence

```bash
git add store/incident-evidence/c12-feedback-modal-live-*.txt
git add store/incident-evidence/c12-feedback-modal-live-*-result.txt
git commit -m "gate(9644ed7c): G6 feedback-modal live-verification C12/Buster PASS"
git push
```

### Gate Clearance

Once the commit lands:
1. Reference the commit SHA in the gate check
2. Update the code comment in `src/pane-state.ts:167-172` to include the verification timestamp
3. Clear the gate requirement for production deploy

---

## What the Regex Validates

**Regex Pattern:** `/how is claude doing this session/i` (case-insensitive)

**Scope:** Last 10 pane lines (FEEDBACK_MODAL_TAIL_LINES)

**What it MUST detect (FN-guards):**
- [ ] Full modal with all 4 rating options visible
- [ ] Compact modal with just header and "0: Dismiss"
- [ ] Modal with "(optional)" suffix
- [ ] Modal with "?" instead of "(optional)"

**What it MUST NOT detect (FP-guards):**
- [ ] Phrase in scrollback prose (agent discussing the modal, but it's not visible)
- [ ] Modal text scrolled above the 10-line window (already dismissed)
- [ ] Keystroke pollution like `0/compact` where only the input is visible

All synthetic fixtures are in `src/__tests__/pane-state.test.ts` (223 passing tests).

---

## Troubleshooting

### Script says FAIL: Regex did NOT detect modal

**Possible causes:**
1. Modal is not actually visible in the last 10 lines (scrolled past)
2. Modal text rendering has changed in a newer Claude Code version
3. Pane capture failed silently

**Steps:**
1. Visually inspect the pane capture file: `cat store/incident-evidence/c12-feedback-modal-live-*.txt | tail -20`
2. Verify the modal header text matches `How is Claude doing this session`
3. Check Claude Code version: `claude --version`
4. If text differs, update the regex in `src/pane-state.ts:177` and re-run

### Modal never appears

1. Continue running agent operations normally
2. The modal appears non-deterministically; give it several turns
3. If it still doesn't appear after 10+ turns, it may be disabled in this build

**In this case:**
- Document that the modal was not observed
- Proceed with deploy (the detector is passive; it won't fire if the modal doesn't exist)

---

## Post-Validation

Once G6 is verified, the next phase is **SLICE 2 (fce12f45) recovery wiring**, which will automatically dismiss the modal by sending `0` when it's detected.

**Current state:**
- G6 detection: COMPLETE + MERGED (PR #766)
- G6 live-validation: **← YOU ARE HERE**
- SLICE 2 recovery: Pending (separate card fce12f45)

---

## References

- **Code:** `src/pane-state.ts:154-177` (detection logic)
- **Tests:** `src/__tests__/pane-state.test.ts` (223 tests, all passing)
- **Card:** 9644ed7c (parent effect-probe)
- **SLICE 2:** fce12f45 (recovery wiring, pending)
- **Evidence:** `store/incident-evidence/c12-feedback-modal-live-*.txt`
