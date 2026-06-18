import type http from 'node:http'
import type { AgentIdentity } from '../agent-token-registry.js'

// Shared shape every route handler in this folder consumes. The dispatcher in
// src/web.ts builds it once per request and walks each module's tryHandle*
// function. A handler returns true once it has written a response, false to
// let the next module try.
export interface RouteContext {
  req: http.IncomingMessage
  res: http.ServerResponse
  path: string
  method: string
  url: URL
  // Token-resolved caller identity (card b1ce5118). For gated /api routes this
  // is the real authenticated identity; for public/unauthenticated paths it is
  // an anonymous, scope-less placeholder. The enforcement routes (messages POST,
  // memories DELETE/PUT) are all gated, so they always receive a real identity.
  identity: AgentIdentity
}

export type RouteHandler = (ctx: RouteContext) => Promise<boolean>
