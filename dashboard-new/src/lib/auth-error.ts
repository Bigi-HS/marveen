import { ApiError } from './api'

/** True when an error is a 401 from the backend (drives the auth-required screen). */
export function isAuthError(err: Error | null | undefined): boolean {
  return err instanceof ApiError && err.status === 401
}
