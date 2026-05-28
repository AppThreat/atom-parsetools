type AuthResult =
  | { ok: true; token: string; expiresAt: number }
  | { ok: false; reason: string };

export function createAuthToken(userId: string): AuthResult {
  if (!userId) {
    return { ok: false, reason: "missing-user" };
  }
  return {
    ok: true,
    token: `token-${userId}`,
    expiresAt: Date.now() + 3600
  };
}

export function readAuthMessage(result: AuthResult): string {
  return result.ok ? result.token : result.reason;
}
