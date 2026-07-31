import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { json } from '../http-helpers.js'
import { logger } from '../../logger.js'
import type { RouteContext } from './types.js'

const METRICS_DIR = '/tmp/metrics'

export async function tryHandleMetrics(ctx: RouteContext): Promise<boolean> {
  const { res, path, method, url } = ctx

  if (path === '/api/metrics/coverage' && method === 'GET') {
    try {
      const urlObj = new URL(url, 'http://dummy')
      const prParam = urlObj.searchParams.get('pr')

      if (!prParam) {
        json(res, { error: 'Missing pr parameter' }, 400)
        return true
      }

      const prNum = parseInt(prParam, 10)
      if (!Number.isFinite(prNum) || prNum <= 0) {
        json(res, { error: 'Invalid pr parameter (must be positive integer)' }, 400)
        return true
      }

      const prDir = join(METRICS_DIR, `pr-${prNum}`)

      let coverage: any = null
      let flaky: any = null

      // Read coverage.json if available
      try {
        const coveragePath = join(prDir, 'coverage.json')
        const coverageText = readFileSync(coveragePath, 'utf-8')
        coverage = JSON.parse(coverageText)
      } catch (err) {
        if ((err as any)?.code !== 'ENOENT') {
          logger.warn({ err, prNum }, 'Failed to read coverage.json')
        }
      }

      // Read flaky-report.json if available
      try {
        const flakyPath = join(prDir, 'flaky-report.json')
        const flakyText = readFileSync(flakyPath, 'utf-8')
        flaky = JSON.parse(flakyText)
      } catch (err) {
        if ((err as any)?.code !== 'ENOENT') {
          logger.warn({ err, prNum }, 'Failed to read flaky-report.json')
        }
      }

      // If neither file exists, return 404
      if (!coverage && !flaky) {
        json(res, { error: `No metrics found for PR #${prNum}` }, 404)
        return true
      }

      // Build response
      const response: Record<string, any> = {
        pr_num: prNum,
        measured_at: new Date().toISOString(),
      }

      if (coverage) {
        response.coverage = {
          pct: coverage.pct,
          delta: coverage.delta || null,
          prev_pct: coverage.prev_pct || null,
          worst_file: coverage.worst_file || null,
          worst_file_delta: coverage.worst_file_delta || null,
          uncovered_lines_added: coverage.uncovered_lines_added || null,
        }
      }

      if (flaky) {
        response.flaky = {
          count: flaky.flaky_tests ? flaky.flaky_tests.length : 0,
          list: (flaky.flaky_tests || []).map((test: any) => ({
            test,
            fail_rate: flaky.tests && flaky.tests[test] ? flaky.tests[test].fail_rate : null,
          })),
          suite_stats: {
            completed: flaky.completed || 0,
            suite_passed: flaky.suite_passed || 0,
            suite_failed: flaky.suite_failed || 0,
          },
        }
      }

      if (flaky && flaky.duration_s !== undefined) {
        response.trend = {
          runtime_s: flaky.duration_s,
        }
      }

      response.measured_by = 'dampier'

      json(res, response)
    } catch (err) {
      logger.error({ err }, 'Error handling metrics/coverage request')
      json(res, { error: 'Internal server error' }, 500)
    }
    return true
  }

  return false
}
