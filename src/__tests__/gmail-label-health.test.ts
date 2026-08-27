/**
 * Tests for POST /api/gmail/label-health (OPS-130, 5e6e0e55).
 */
import { describe, it, expect } from 'vitest'
import { checkLabelHealth, type GmailLabel } from '../web/routes/gmail-label-health.js'

const SYSTEM_LABELS: GmailLabel[] = [
  { id: 'INBOX', name: 'INBOX' },
  { id: 'SENT', name: 'Sent' },
  { id: 'TRASH', name: 'Trash' },
  { id: 'SPAM', name: 'Spam' },
  { id: 'CATEGORY_PERSONAL', name: 'Category' },
]

const CUSTOM_LABELS: GmailLabel[] = [
  { id: 'Label_123456', name: 'Buccaneer' },
  { id: 'Label_789012', name: 'Fleet' },
]

describe('checkLabelHealth (pure, OPS-130)', () => {
  it('healthy=true when custom labels are present', () => {
    const r = checkLabelHealth([...SYSTEM_LABELS, ...CUSTOM_LABELS])
    expect(r.healthy).toBe(true)
    expect(r.customLabelCount).toBe(2)
    expect(r.systemLabelCount).toBe(SYSTEM_LABELS.length)
  })

  it('healthy=false when only system labels (0 custom) = wrong account', () => {
    const r = checkLabelHealth(SYSTEM_LABELS)
    expect(r.healthy).toBe(false)
    expect(r.customLabelCount).toBe(0)
    expect(r.reason).toMatch(/wrong Gmail account/)
  })

  it('healthy=false when labels array is empty', () => {
    const r = checkLabelHealth([])
    expect(r.healthy).toBe(false)
    expect(r.customLabelCount).toBe(0)
  })

  it('system label with Label_* in NAME but non-Label_ id is NOT counted as custom', () => {
    // Edge: name contains "Label_" but id does not start with it
    const tricky: GmailLabel = { id: 'IMPORTANT', name: 'Label_Important' }
    const r = checkLabelHealth([tricky])
    expect(r.healthy).toBe(false)  // id IMPORTANT != Label_*, so not custom
    expect(r.customLabelCount).toBe(0)
  })

  it('exactly 1 custom label is healthy', () => {
    const r = checkLabelHealth([CUSTOM_LABELS[0]])
    expect(r.healthy).toBe(true)
    expect(r.customLabelCount).toBe(1)
  })
})
