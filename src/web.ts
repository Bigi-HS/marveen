import http from 'node:http'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { execSync, execFileSync } from 'node:child_process'
import { PROJECT_ROOT, WEB_HOST, DASHBOARD_PUBLIC_URL } from './config.js'
import { loadOrCreateDashboardToken, initDashboardToken, getDashboardToken, checkBearerToken, buildDashboardAccessMessage, createSession, verifySession, revokeSession, parseCookies, SESSION_COOKIE_NAME, SESSION_MAX_AGE_SECONDS } from './web/dashboard-auth.js'
import { json, readBody } from './web/http-helpers.js'
import { createRateLimiter } from './web/rate-limit.js'
import { AGENTS_BASE_DIR, listAgentNames } from './web/agent-config.js'
import { ensureAgentHooks, ensureDefaultScheduledTasks } from './web/agent-scaffold.js'
import { refreshMarveenBotUsername } from './web/telegram.js'
import { startMessageRouter } from './web/message-router.js'
import { startUpdateChecker } from './web/update-checker.js'
import { startMcpListChecker } from './web/mcp-list.js'
import { startScheduleRunner } from './web/schedule-runner.js'
import { startChannelPluginMonitor } from './web/channel-monitor.js'
import { startInboundProber } from './web/inbound-probe.js'
import { startChannelHealthMonitor } from './web/channel-health-monitor.js'
import { startStuckInputWatcher } from './web/stuck-input-watcher.js'
import { startStuckToolCallWatcher } from './web/stuck-tool-call-watcher.js'
import { startReauthHealer } from './web/reauth-healer.js'
import { startAutoRestartRunner } from './web/auto-restart-runner.js'
import { startSessionSizeWatcher } from './web/session-size-watcher.js'
import { logger } from './logger.js'
import { tryHandleProfiles } from './web/routes/profiles.js'
import { tryHandleMessages } from './web/routes/messages.js'
import { tryHandleAgentTerminal } from './web/routes/agent-terminal.js'
import { tryHandleAgentTaskState } from './web/routes/agent-taskstate.js'
import { sweepOrphanTaskStates } from './web/agent-taskstate.js'
import { tryHandleDailyLog } from './web/routes/daily-log.js'
import { tryHandleMemories } from './web/routes/memories.js'
import { tryHandleMigrate } from './web/routes/migrate.js'
import { tryHandleKanban } from './web/routes/kanban.js'
import { tryHandleSchedules } from './web/routes/schedules.js'
import { tryHandleConnectors } from './web/routes/connectors.js'
import { tryHandleConnectorsHu } from './web/routes/connectors-hu.js'
import { tryHandleAgentsSkills } from './web/routes/agents-skills.js'
import { tryHandleSkills } from './web/routes/skills.js'
import { tryHandleAgents } from './web/routes/agents.js'
import { tryHandleMarveen } from './web/routes/marveen.js'
import { tryHandleRecall } from './web/routes/recall.js'
import { tryHandleBackgroundTasks, sweepOrphanedBackgroundTasks } from './web/routes/background-tasks.js'
import { tryHandleOverview } from './web/routes/overview.js'
import { tryHandleUpdates } from './web/routes/updates.js'
import { tryHandleStatus } from './web/routes/status.js'
import { tryHandleAutonomy } from './web/routes/autonomy.js'
import { tryHandleTokenUsage } from './web/routes/token-usage.js'
import { tryHandleIdeas } from './web/routes/ideas.js'
import { tryHandleToolLog } from './web/routes/tool-log.js'
import { tryHandleAgentCategories } from './web/routes/agent-categories.js'
import { tryHandleAdmin } from './web/routes/admin.js'
import { tryHandleStatic } from './web/routes/static.js'
import type { RouteContext } from './web/routes/types.js'

const WEB_DIR = join(PROJECT_ROOT, 'web')

function ensureDirs() {
  mkdirSync(AGENTS_BASE_DIR, { recursive: true })
}

export function startWebServer(port = 3420): http.Server {
  // SECURITY: Server binds to 127.0.0.1 (see server.listen below). The allowed
  // browser origins mirror that -- anything else is rejected to prevent CSRF
  // from malicious websites the user may visit while the dashboard is running.
  ensureDirs()

  const DASHBOARD_TOKEN = loadOrCreateDashboardToken()
  // Seed the in-memory token the auth middleware checks. The middleware reads it
  // via getDashboardToken() (not this const) so the admin rotate-token endpoint
  // can swap it at runtime without a restart. DASHBOARD_TOKEN is only used for
  // the one-time startup access message below.
  initDashboardToken(DASHBOARD_TOKEN)
  const allowedOrigins = new Set([
    `http://localhost:${port}`,
    `http://127.0.0.1:${port}`,
    ...( WEB_HOST !== 'localhost' && WEB_HOST !== '127.0.0.1' ? [`http://${WEB_HOST}:${port}`] : []),
    ...(DASHBOARD_PUBLIC_URL ? [DASHBOARD_PUBLIC_URL.replace(/\/$/, '')] : []),
  ])
  const isSafeMethod = (m: string) => m === 'GET' || m === 'HEAD' || m === 'OPTIONS'

  // Per-IP rate limiting (defence-in-depth; the dashboard is tailnet-only, so
  // this guards against token brute-force and accidental request storms, not
  // public-scale traffic). Two tiers keyed by client IP:
  //   - strict: POST /api/auth/login -- anti-brute-force (~5/min)
  //   - lenient: every other /api/* call (~100/10s burst)
  // The long-lived SSE pane stream and static assets are never rate-limited.
  const loginLimiter = createRateLimiter({ capacity: 5, refillPerSec: 5 / 60 })
  const apiLimiter = createRateLimiter({ capacity: 100, refillPerSec: 10 })
  // Bound memory under a churn of distinct client IPs; prune idle buckets.
  const rateLimitPruneInterval = setInterval(() => {
    loginLimiter.prune()
    apiLimiter.prune()
  }, 5 * 60 * 1000)
  if (typeof rateLimitPruneInterval.unref === 'function') rateLimitPruneInterval.unref()
  // Resolve the client IP, honouring the first hop of X-Forwarded-For set by
  // the Tailscale Serve proxy in front of us. Falls back to the socket peer.
  const clientIp = (req: http.IncomingMessage): string => {
    const xff = req.headers['x-forwarded-for']
    const raw = Array.isArray(xff) ? xff[0] : xff
    const first = raw?.split(',')[0]?.trim()
    return first || req.socket.remoteAddress || 'unknown'
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://localhost:${port}`)
    const path = url.pathname
    const method = req.method || 'GET'

    const origin = req.headers.origin
    if (origin && allowedOrigins.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin)
      res.setHeader('Vary', 'Origin')
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
    }
    if (method === 'OPTIONS') { res.writeHead(204); res.end(); return }

    // Block state-changing requests from browsers running on foreign origins.
    // Same-origin fetches from the dashboard don't set Origin on some browsers, so we
    // accept requests where Origin is absent OR whitelisted. Requests carrying a foreign
    // Origin are rejected outright (this is the primary CSRF defence).
    if (!isSafeMethod(method) && origin && !allowedOrigins.has(origin)) {
      res.writeHead(403, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Origin not allowed' }))
      return
    }

    // Per-IP rate limiting (before the auth gate, so brute-force attempts are
    // throttled even when they carry no/invalid credentials). Skips the
    // long-lived SSE pane stream and non-/api static assets.
    if (path.startsWith('/api/') && !/^\/api\/agents\/[^/]+\/pane\/stream$/.test(path)) {
      const ip = clientIp(req)
      const isLogin = method === 'POST' && path === '/api/auth/login'
      const limiter = isLogin ? loginLimiter : apiLimiter
      const verdict = limiter.allow(ip)
      if (!verdict.allowed) {
        res.writeHead(429, {
          'Content-Type': 'application/json',
          'Retry-After': String(Math.ceil(verdict.retryAfterMs / 1000)),
        })
        res.end(JSON.stringify({ error: 'rate limited' }))
        return
      }
    }

    // Auth gate: every /api/* route requires EITHER a valid HttpOnly session
    // cookie (browser UI, set via POST /api/auth/login) OR a bearer token in the
    // Authorization header (scripts/curl, backward-compat). Exceptions: the
    // auth-status probe (so the client can tell whether it needs to prompt the
    // user), the login/logout endpoints themselves, and GET requests for avatar
    // images (loaded via <img src> which can't carry headers).
    const cookies = parseCookies(req.headers.cookie)
    const sessionValue = cookies[SESSION_COOKIE_NAME]
    // Honour Tailscale Serve's forwarded scheme so the Secure flag is set when
    // the operator reaches the dashboard over HTTPS (*.ts.net), but not on the
    // plain-HTTP loopback bind.
    const forwardedProto = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim()
    const isHttps = forwardedProto === 'https' || (req.socket as { encrypted?: boolean }).encrypted === true
    const hasValidSession = () => verifySession(sessionValue).valid
    const hasValidBearer = () => checkBearerToken(req.headers.authorization, getDashboardToken())

    // Login: exchange the access token for a session cookie. Public (it IS the
    // authentication step), but rate-limited only by the token check itself.
    if (path === '/api/auth/login' && method === 'POST') {
      let token = ''
      try {
        const raw = (await readBody(req, { maxBytes: 4096 })).toString('utf-8')
        token = raw ? (JSON.parse(raw).token ?? '') : ''
      } catch { token = '' }
      if (!checkBearerToken(`Bearer ${token}`, getDashboardToken())) {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Invalid token' }))
        return
      }
      const cookie = [
        `${SESSION_COOKIE_NAME}=${createSession()}`,
        'HttpOnly', 'SameSite=Strict', 'Path=/', `Max-Age=${SESSION_MAX_AGE_SECONDS}`,
        ...(isHttps ? ['Secure'] : []),
      ].join('; ')
      res.setHeader('Set-Cookie', cookie)
      return json(res, { ok: true })
    }
    // Logout: revoke this session and clear the cookie.
    if (path === '/api/auth/logout' && method === 'POST') {
      revokeSession(sessionValue)
      res.setHeader('Set-Cookie', `${SESSION_COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${isHttps ? '; Secure' : ''}`)
      return json(res, { ok: true })
    }
    const isPublicApi =
      (path === '/api/auth/status' && method === 'GET') ||
      (method === 'GET' && (
        path === '/api/marveen/avatar' ||
        /^\/api\/agents\/[^/]+\/avatar$/.test(path)
      ))
    if (path === '/api/auth/status' && method === 'GET') {
      return json(res, { authenticated: hasValidSession() || hasValidBearer() })
    }
    // The live pane SSE stream is consumed via EventSource, which cannot set an
    // Authorization header. The session cookie is sent automatically on
    // same-origin EventSource requests; we also still accept the legacy ?token=
    // for backward compat (its removal is a follow-on chunk).
    const isSseStream = method === 'GET' && /^\/api\/agents\/[^/]+\/pane\/stream$/.test(path)
    if (path.startsWith('/api/') && !isPublicApi) {
      const queryOk = isSseStream && checkBearerToken(`Bearer ${url.searchParams.get('token') ?? ''}`, getDashboardToken())
      if (!hasValidSession() && !hasValidBearer() && !queryOk) {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Unauthorized' }))
        return
      }
    }

    try {
      const routeCtx: RouteContext = { req, res, path, method, url }

      if (await tryHandleProfiles(routeCtx)) return
      if (await tryHandleMessages(routeCtx)) return
      if (await tryHandleDailyLog(routeCtx)) return
      if (await tryHandleMemories(routeCtx)) return
      if (await tryHandleMigrate(routeCtx)) return
      if (await tryHandleKanban(routeCtx)) return
      if (await tryHandleSchedules(routeCtx)) return
      if (await tryHandleConnectorsHu(routeCtx)) return
      if (await tryHandleConnectors(routeCtx)) return
      if (await tryHandleAgentsSkills(routeCtx)) return
      if (await tryHandleSkills(routeCtx)) return
      if (await tryHandleAgentTerminal(routeCtx)) return
      if (await tryHandleAgentTaskState(routeCtx)) return
      if (await tryHandleAgentCategories(routeCtx)) return
      if (await tryHandleAdmin(routeCtx)) return
      if (await tryHandleAgents(routeCtx, WEB_DIR)) return
      if (await tryHandleMarveen(routeCtx, WEB_DIR)) return
      if (await tryHandleBackgroundTasks(routeCtx)) return
      if (await tryHandleRecall(routeCtx)) return
      if (await tryHandleOverview(routeCtx)) return
      if (await tryHandleUpdates(routeCtx)) return
      if (await tryHandleStatus(routeCtx)) return
      if (await tryHandleAutonomy(routeCtx)) return
      if (await tryHandleTokenUsage(routeCtx)) return
      if (await tryHandleIdeas(routeCtx)) return
      if (await tryHandleToolLog(routeCtx)) return
      if (await tryHandleStatic(routeCtx, WEB_DIR)) return

      res.writeHead(404)
      res.end('Not found')
    } catch (err) {
      logger.error({ err }, 'Web szerver hiba')
      json(res, { error: 'Szerver hiba' }, 500)
    }
  })

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      // Try to reclaim the port only if the listener is another node/dashboard
      // process owned by us. Blind `lsof -ti | xargs kill -9` would take down
      // whatever happens to be on the port (e.g. an unrelated dev server),
      // and under launchd it also race-kills the not-yet-dead predecessor.
      logger.warn({ port }, 'Web port foglalt, probalok felszabaditani...')
      try {
        const pidsRaw = execSync(`lsof -ti :${port} 2>/dev/null || true`, { timeout: 3000, encoding: 'utf-8' }).trim()
        const pids = pidsRaw.split('\n').map(s => s.trim()).filter(Boolean).map(Number).filter(n => Number.isFinite(n) && n > 0)
        const uid = typeof process.getuid === 'function' ? process.getuid() : null
        const victims: number[] = []
        for (const pid of pids) {
          if (pid === process.pid) continue
          let cmd = ''
          try {
            cmd = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'comm='], { timeout: 2000, encoding: 'utf-8' }).trim()
          } catch { continue }
          if (uid !== null) {
            try {
              const ownerUid = parseInt(execFileSync('/bin/ps', ['-p', String(pid), '-o', 'uid='], { timeout: 2000, encoding: 'utf-8' }).trim(), 10)
              if (Number.isFinite(ownerUid) && ownerUid !== uid) continue
            } catch { continue }
          }
          if (!/node|tsx/i.test(cmd)) {
            logger.warn({ port, pid, cmd }, 'Port held by non-node process -- refusing to kill')
            continue
          }
          victims.push(pid)
        }
        for (const pid of victims) {
          try { process.kill(pid, 'SIGTERM') } catch { /* already gone */ }
        }
        if (victims.length) {
          setTimeout(() => {
            for (const pid of victims) {
              try {
                process.kill(pid, 0)
                try { process.kill(pid, 'SIGKILL') } catch { /* gone */ }
              } catch { /* gone */ }
            }
            server.listen(port)
          }, 1500)
        } else {
          logger.error({ port }, 'Port foglalt de nem talaltunk felszabadithato node processt -- kilepes')
          process.exit(1)
        }
      } catch (e) {
        logger.error({ err: e }, 'Port-reclaim failed')
      }
    } else {
      logger.error({ err }, 'Web szerver hiba')
    }
  })

  server.listen(port, WEB_HOST, () => {
    logger.info({ port }, `Web dashboard: http://localhost:${port}`)
    // Do NOT log the bearer token: launchd/journal/pipe captures of the
    // structured log would otherwise carry a root-equivalent credential.
    // Print the access instructions to stderr (interactive terminal only, not the
    // pino stream). The token is on its OWN line and never in the URL, so a
    // pasted/logged URL cannot leak the credential.
    process.stderr.write(buildDashboardAccessMessage(port, DASHBOARD_TOKEN))
  })

  const routerInterval = startMessageRouter()
  logger.info('Agent message router started (5s poll)')

  const scheduleInterval = startScheduleRunner()
  logger.info('Schedule runner started (60s poll)')

  const pluginMonitorInterval = startChannelPluginMonitor()
  logger.info('Channel plugin health monitor started (60s poll)')

  // Userbot inbound-probe (gold-standard deafness detector). Safe no-op until
  // the prober session file + allowlist are configured. Wrapped so a failure
  // never crashes server startup.
  try {
    startInboundProber()
  } catch (err) {
    logger.warn({ err }, 'Inbound prober failed to start')
  }

  const channelHealthInterval = startChannelHealthMonitor()
  logger.info('Channel MCP health monitor started (60s poll, 45s offset)')

  const stuckInputInterval = startStuckInputWatcher()
  logger.info('Stuck-input watcher started (15s poll, 20s offset)')

  const stuckToolCallInterval = startStuckToolCallWatcher()
  logger.info('Stuck-tool-call watcher started (30s poll, 35s offset)')

  const reauthHealerInterval = startReauthHealer()
  if (reauthHealerInterval) logger.info('Reauth healer started (3min poll, 90s offset)')

  const autoRestartInterval = startAutoRestartRunner()
  logger.info('Auto-restart runner started (60s poll, 40s offset)')

  const sessionSizeInterval = startSessionSizeWatcher()
  logger.info('Session-size watcher started (10min poll, 5min offset)')

  const updateCheckerInterval = startUpdateChecker()
  logger.info('Update checker started (15min poll)')

  // Warm the MCP list cache so the Connectors page reflects claude.ai OAuth
  // connectors on first load. 30s delay lets the main-channels session settle
  // first so the telegram plugin's single-poller token is claimed before
  // `claude mcp list` spawns it for a health check.
  startMcpListChecker()
  logger.info('MCP list cache warmup scheduled (30s delay, manual refresh only)')

  // Warm the Marveen bot username cache so /api/marveen returns @username on
  // the first dashboard load. Re-fetched lazily otherwise.
  refreshMarveenBotUsername().catch(() => {})

  // Backfill the shared hooks into existing agents' settings.json: the full
  // template block for permissions-only agents, or a targeted merge of the
  // SessionStart memory auto-inject hook for agents that already have a hooks
  // block (those are skipped by the all-or-nothing seed and would otherwise
  // never receive a hook added to the template after they were scaffolded).
  try {
    const patched: string[] = []
    for (const agentName of listAgentNames()) {
      if (ensureAgentHooks(agentName)) patched.push(agentName)
    }
    if (patched.length) logger.info({ patched }, 'Agent hooks backfilled into settings.json')
  } catch (err) {
    logger.warn({ err }, 'Agent hook backfill skipped')
  }

  try {
    ensureDefaultScheduledTasks()
    logger.info('Default scheduled tasks seeded')
  } catch (err) {
    logger.warn({ err }, 'Scheduled tasks seed skipped')
  }

  try {
    sweepOrphanedBackgroundTasks()
  } catch (err) {
    logger.warn({ err }, 'Background task sweep skipped')
  }

  try {
    const swept = sweepOrphanTaskStates(Date.now())
    if (swept > 0) logger.info({ swept }, 'Orphan agent task-state records swept')
  } catch (err) {
    logger.warn({ err }, 'Task-state orphan sweep skipped')
  }

  const origClose = server.close.bind(server)
  server.close = (cb?: (err?: Error) => void) => {
    clearInterval(routerInterval)
    clearInterval(scheduleInterval)
    if (pluginMonitorInterval) clearInterval(pluginMonitorInterval)
    clearInterval(channelHealthInterval)
    clearInterval(stuckInputInterval)
    clearInterval(stuckToolCallInterval)
    if (reauthHealerInterval) clearInterval(reauthHealerInterval)
    clearInterval(autoRestartInterval)
    clearInterval(sessionSizeInterval)
    clearInterval(updateCheckerInterval)
    clearInterval(rateLimitPruneInterval)
    return origClose(cb)
  }

  return server
}
