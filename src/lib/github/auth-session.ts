import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { NextRequest } from "next/server";
import { GitHubFetchError } from "./errors";

export const GITHUB_SESSION_COOKIE = "github_session";
export const GITHUB_SESSION_KEY_ENV = "GITHUB_SESSION_ENCRYPTION_KEY";

const IV_LENGTH = 12;
const TAG_LENGTH = 16;

function encryptionKey(): Buffer {
  const encodedKey = process.env[GITHUB_SESSION_KEY_ENV];
  if (!encodedKey) throw new GitHubFetchError("server_error", "GitHub 세션 암호화 키가 설정되지 않았습니다.");

  const key = Buffer.from(encodedKey, "base64");
  if (key.length !== 32) {
    throw new GitHubFetchError("server_error", "GitHub 세션 암호화 키는 base64로 인코딩한 32바이트 값이어야 합니다.");
  }
  return key;
}

export function encryptGitHubToken(token: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64url");
}

export function decryptGitHubToken(value: string): string {
  try {
    const payload = Buffer.from(value, "base64url");
    if (payload.length <= IV_LENGTH + TAG_LENGTH) throw new Error("Invalid session payload");
    const iv = payload.subarray(0, IV_LENGTH);
    const tag = payload.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(payload.subarray(IV_LENGTH + TAG_LENGTH)), decipher.final()]).toString("utf8");
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
