import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { NextRequest } from "next/server";
import { GitHubFetchError } from "./errors";

export const GITHUB_SESSION_COOKIE = "github_session";
export const GITHUB_SESSION_KEY_ENV = "GITHUB_SESSION_ENCRYPTION_KEY";
export const GITHUB_SESSION_MAX_AGE_SECONDS = 28800;

const COOKIE_OPTIONS = "Path=/; HttpOnly; Secure; SameSite=Lax";

export function createGitHubSessionCookie(value: string): string {
  return `${GITHUB_SESSION_COOKIE}=${value}; ${COOKIE_OPTIONS}; Max-Age=${GITHUB_SESSION_MAX_AGE_SECONDS}`;
}

export function deleteGitHubSessionCookie(): string {
  return `${GITHUB_SESSION_COOKIE}=; ${COOKIE_OPTIONS}; Max-Age=0`;
}

const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const ISSUED_AT_LENGTH = 8;

function encryptionKey(): Buffer {
  const encodedKey = process.env[GITHUB_SESSION_KEY_ENV];
  if (!encodedKey) throw new GitHubFetchError("server_error", "GitHub 세션 암호화 키가 설정되지 않았습니다.");

  const key = Buffer.from(encodedKey, "base64");
  if (key.length !== 32) {
    throw new GitHubFetchError("server_error", "GitHub 세션 암호화 키는 base64로 인코딩한 32바이트 값이어야 합니다.");
  }
  return key;
}

/**
 * 발급 시각을 평문 앞에 붙여 함께 암호화합니다. 쿠키의 `Max-Age`는 브라우저에게만 하는 부탁이라
 * 값을 복사해 두면 만료 뒤에도 그대로 씁니다. 서버가 수명을 판단할 근거는 요청에 실려 온 값 안에만
 * 있을 수 있습니다. GCM 인증 태그가 평문 전체를 덮으므로 이 시각은 변조되지 않습니다.
 */
export function encryptGitHubToken(token: string): string {
  const issuedAt = Buffer.alloc(ISSUED_AT_LENGTH);
  issuedAt.writeBigUInt64BE(BigInt(Date.now()));
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const plaintext = Buffer.concat([issuedAt, Buffer.from(token, "utf8")]);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64url");
}

export function decryptGitHubToken(value: string): string {
  try {
    const payload = Buffer.from(value, "base64url");
    if (payload.length <= IV_LENGTH + TAG_LENGTH + ISSUED_AT_LENGTH) throw new Error("Invalid session payload");
    const iv = payload.subarray(0, IV_LENGTH);
    const tag = payload.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(payload.subarray(IV_LENGTH + TAG_LENGTH)), decipher.final()]);
    const age = Date.now() - Number(plaintext.readBigUInt64BE(0));
    if (age < 0 || age > GITHUB_SESSION_MAX_AGE_SECONDS * 1000) throw new Error("Expired session");
    return plaintext.subarray(ISSUED_AT_LENGTH).toString("utf8");
  } catch (error) {
    if (error instanceof GitHubFetchError) throw error;
    throw new GitHubFetchError("auth_revoked", "GitHub 인증 세션이 없거나 유효하지 않습니다.");
  }
}

export function getGitHubTokenFromRequest(request: NextRequest): string {
  const encryptedToken = request.cookies.get(GITHUB_SESSION_COOKIE)?.value;
  if (!encryptedToken) throw new GitHubFetchError("auth_revoked", "GitHub 인증 세션이 없습니다.");
  return decryptGitHubToken(encryptedToken);
}
