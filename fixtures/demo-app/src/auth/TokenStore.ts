/**
 * Lives under an `auth/` path, so triage must route this to Tier C and refuse to
 * let the model edit it — regardless of how bad its coverage is.
 */
export interface Session {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

let cached: Session | null = null;

export function setSession(s: Session): void {
  cached = s;
}

export function getSession(): Session | null {
  if (!cached) return null;
  if (cached.expiresAt < Date.now()) {
    cached = null;
    return null;
  }
  return cached;
}

export function clearSession(): void {
  cached = null;
}
