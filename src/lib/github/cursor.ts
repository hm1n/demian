import type { AuthoredCommitsCursor } from "./commits";

const SHA_PATTERN = /^[0-9a-f]{40}$/i;
const LOGIN_PATTERN = /^[A-Za-z0-9-]{1,39}$/;

export function encodeCommitCursor(cursor: AuthoredCommitsCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

export function decodeCommitCursor(value: unknown): AuthoredCommitsCursor | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new Error("invalid cursor");
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (
      typeof parsed !== "object" || parsed === null ||
      !("headSha" in parsed) || !SHA_PATTERN.test(String(parsed.headSha)) ||
      !("login" in parsed) || !LOGIN_PATTERN.test(String(parsed.login)) ||
      !("page" in parsed) || !Number.isSafeInteger(parsed.page) || Number(parsed.page) < 1
    ) throw new Error("invalid cursor");
    return { headSha: String(parsed.headSha), login: String(parsed.login), page: Number(parsed.page) };
  } catch {
    throw new Error("invalid cursor");
  }
}
