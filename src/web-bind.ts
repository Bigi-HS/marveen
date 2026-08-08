import type { Server } from 'node:http'

/**
 * Card SEC/a805f9f0: the single bind path for the dashboard server.
 *
 * `server.listen(port)` with no host binds to `::` -- every interface, dual-stack.
 * `server.listen(port, '127.0.0.1')` binds loopback only. web.ts used to do the
 * first on its port-reclaim path and the second on its normal path, so whether the
 * dashboard was publicly reachable depended on WHICH BRANCH RAN, and nothing was
 * logged either way. Both sites now go through here, and the caller is handed the
 * binding it actually got so "we are on loopback" can be measured, not assumed.
 */
export interface BoundAddress {
  address: string
  family: string
  port: number
}

/** The binding the socket actually has, or null if it is not listening yet. */
export function describeBinding(server: Server): BoundAddress | null {
  const addr = server.address()
  if (!addr || typeof addr === 'string') return null
  return { address: addr.address, family: addr.family, port: addr.port }
}

/**
 * Listen on `port`, scoped to `host`. The host argument is not optional on
 * purpose: an omitted host is the defect this module exists to prevent.
 */
export function bindServer(
  server: Server,
  port: number,
  host: string,
  onListening?: (bound: BoundAddress | null) => void,
): void {
  server.listen(port, host, () => onListening?.(describeBinding(server)))
}
