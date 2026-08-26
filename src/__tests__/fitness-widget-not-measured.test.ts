/**
 * Source-text tests for DASH-025 (86e578c6): fitness widget not-measured rendering.
 *
 * Problem: empty/null status was rendered identically to "Edzés" (generic),
 * and actual_val=null (never logged) looked like actual_val=0 (logged as zero).
 * Fix: "Még nincs" for unset habit status, "Nem naplózott" for null metric value.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(join(__dirname, '..', '..', 'web', 'app.js'), 'utf-8')

describe('fitness widget not-measured rendering (DASH-025, 86e578c6)', () => {
  it('trainingLabel returns "Még nincs" for empty/null status', () => {
    expect(SRC).toContain("if (!status) return 'Még nincs'")
  })

  it('metric with null actual_val shows "Nem naplózott" in grey (not same as 0)', () => {
    expect(SRC).toContain("chip.classList.add('todo-chip-grey')")
    expect(SRC).toContain('Nem naplózott')
  })

  it('metric with actual_val=null check handles empty string too', () => {
    // The guard covers both null and '' (empty string from partial PUT)
    expect(SRC).toContain("item.actual_val == null || item.actual_val === ''")
  })

  it('metric with actual_val=0 still shows the diff (0 is a real logged value)', () => {
    // After the null check, the diff branch is reached for actual_val=0
    expect(SRC).toContain('Math.round(item.actual_val - item.target_val)')
  })

  it('habit chip class still returns grey for unset status (no regression)', () => {
    expect(SRC).toContain("return 'todo-chip-grey' // rest or unset: never a failure color")
  })
})
