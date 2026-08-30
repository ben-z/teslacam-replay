import { timingSafeEqual } from "crypto";

export interface BasicAuthConfig {
  username: string;
  password: string;
}

export function basicAuthConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env
): BasicAuthConfig | null {
  const username = env.BASIC_AUTH_USER;
  const password = env.BASIC_AUTH_PASSWORD;

  if (!username && !password) return null;
  if (!username || !password) {
    throw new Error("BASIC_AUTH_USER and BASIC_AUTH_PASSWORD must be set together");
  }

  return { username, password };
}

function safeEqual(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length &&
    timingSafeEqual(actualBuffer, expectedBuffer);
}

export function isBasicAuthAuthorized(
  authorization: string | undefined,
  config: BasicAuthConfig
): boolean {
  const match = authorization?.match(/^Basic\s+([A-Za-z0-9+/=]+)$/i);
  if (!match) return false;

  let decoded: string;
  try {
    decoded = Buffer.from(match[1], "base64").toString("utf8");
  } catch {
    return false;
  }

  const separator = decoded.indexOf(":");
  if (separator < 0) return false;

  return safeEqual(decoded.slice(0, separator), config.username) &&
    safeEqual(decoded.slice(separator + 1), config.password);
}
