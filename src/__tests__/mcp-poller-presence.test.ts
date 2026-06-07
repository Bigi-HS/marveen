import { describe, it, expect } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { shouldReconnectOnMissingPoller } from '../web/channel-health-monitor.js'
import { parsePollerPidsFromPs, probeChannelPollerPresence } from '../web/channel-poller-reap.js'

// Item 3: catch an MCP poller killed EXTERNALLY (dashboard deploy-restart /
// OS-sleep) that the pane ✘-marker never renders. The decision is pure and the
// presence probe rests on parsePollerPidsFromPs, both tested here.

describe('shouldReconnectOnMissingPoller', () => {
  it('reconnects ONLY when channel is expected up AND poller is certainly absent', () => {
    expect(shouldReconnectOnMissingPoller({ expectedUp: true, pollerPresent: false })).toBe(true)
  })
  it('does not reconnect when the poller is present', () => {
    expect(shouldReconnectOnMissingPoller({ expectedUp: true, pollerPresent: true })).toBe(false)
  })
  it('does not reconnect when presence is unknown (null) -- fail-safe', () => {
    // The probe could not determine presence (ps scan failed, no live bot.pid).
    // Never act on the live orchestrator without certainty.
    expect(shouldReconnectOnMissingPoller({ expectedUp: true, pollerPresent: null })).toBe(false)
  })
  it('does not reconnect for a channel-less agent even if no poller exists', () => {
    expect(shouldReconnectOnMissingPoller({ expectedUp: false, pollerPresent: false })).toBe(false)
    expect(shouldReconnectOnMissingPoller({ expectedUp: false, pollerPresent: null })).toBe(false)
    expect(shouldReconnectOnMissingPoller({ expectedUp: false, pollerPresent: true })).toBe(false)
  })
})

describe('parsePollerPidsFromPs (presence scan)', () => {
  const envVar = 'TELEGRAM_STATE_DIR'
  const dir = '/home/domin/marveen/agents/dave/.claude/channels/telegram'

  it('extracts the pid of a poller row carrying the matching state dir', () => {
    const ps = [
      '  455335 pts/6 S+ 0:00 bun run --cwd /plugins/telegram/0.0.6 start HOME=/home/domin TELEGRAM_STATE_DIR=' + dir + ' TERM=xterm',
      '  999 pts/0 S 0:00 some-other-process',
    ].join('\n')
    expect(parsePollerPidsFromPs(ps, envVar, dir)).toEqual([455335])
  })

  it('returns empty when no row carries the state dir (poller absent)', () => {
    const ps = '  999 pts/0 S 0:00 bun run --cwd /plugins/telegram/0.0.6 start TELEGRAM_STATE_DIR=/some/other/agent/telegram'
    expect(parsePollerPidsFromPs(ps, envVar, dir)).toEqual([])
  })

  it('does not match a different agent whose dir merely shares a prefix is still distinct', () => {
    const other = '/home/domin/marveen/agents/dave2/.claude/channels/telegram'
    const ps = '  500 pts/0 S 0:00 bun start TELEGRAM_STATE_DIR=' + other
    expect(parsePollerPidsFromPs(ps, envVar, dir)).toEqual([])
  })

  it('ignores rows without a leading pid', () => {
    const ps = 'garbage TELEGRAM_STATE_DIR=' + dir
    expect(parsePollerPidsFromPs(ps, envVar, dir)).toEqual([])
  })

  it('P9-F3: does NOT match a longer dir the value is an exact prefix of', () => {
    // includes() would false-positive here; the exact-match guard rejects it.
    const ps = '  600 pts/0 S 0:00 bun start ' + envVar + '=' + dir + '-extra HOME=/h'
    expect(parsePollerPidsFromPs(ps, envVar, dir)).toEqual([])
  })

  it('P9-F3: matches when the value is followed by whitespace (normal env dump)', () => {
    const ps = '  601 pts/0 S 0:00 bun start ' + envVar + '=' + dir + ' HOME=/h'
    expect(parsePollerPidsFromPs(ps, envVar, dir)).toEqual([601])
  })

  it('P9-F3: matches when the value is at end-of-line', () => {
    const ps = '  602 pts/0 S 0:00 bun start ' + envVar + '=' + dir
    expect(parsePollerPidsFromPs(ps, envVar, dir)).toEqual([602])
  })
})

describe('probeChannelPollerPresence (P9-F2 shared per-tick scan)', () => {
  // A throwaway agent dir guarantees no bot.pid on disk, so the verdict is driven
  // purely by the supplied ps scan -- no real `ps eww -e` is forked.
  const agentDir = join(tmpdir(), 'eph-poller-probe-nonexistent-agent')

  it('uses the SUPPLIED scan instead of forking its own ps (absent -> false)', () => {
    const scan = { ok: true, output: '  999 pts/0 S 0:00 some-unrelated-process\n' }
    expect(probeChannelPollerPresence('telegram', agentDir, scan)).toBe(false)
  })

  it('fails safe to null when the supplied scan failed (ok=false)', () => {
    const scan = { ok: false, output: '' }
    expect(probeChannelPollerPresence('telegram', agentDir, scan)).toBeNull()
  })
})
