import { describe, expect, it } from "vitest";
import {
  basicAuthConfigFromEnv,
  isBasicAuthAuthorized,
  type BasicAuthConfig,
} from "./basic-auth.js";

const config: BasicAuthConfig = {
  username: "ben",
  password: "correct horse battery staple",
};

function authorization(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

describe("basicAuthConfigFromEnv", () => {
  it("disables authentication when both variables are absent", () => {
    expect(basicAuthConfigFromEnv({})).toBeNull();
  });

  it("requires both variables", () => {
    expect(() => basicAuthConfigFromEnv({ BASIC_AUTH_USER: "ben" })).toThrow(
      "BASIC_AUTH_USER and BASIC_AUTH_PASSWORD must be set together"
    );
  });

  it("returns a complete configuration", () => {
    expect(basicAuthConfigFromEnv({
      BASIC_AUTH_USER: config.username,
      BASIC_AUTH_PASSWORD: config.password,
    })).toEqual(config);
  });
});

describe("isBasicAuthAuthorized", () => {
  it("accepts matching credentials", () => {
    expect(isBasicAuthAuthorized(
      authorization(config.username, config.password),
      config
    )).toBe(true);
  });

  it("rejects missing and malformed credentials", () => {
    expect(isBasicAuthAuthorized(undefined, config)).toBe(false);
    expect(isBasicAuthAuthorized("Bearer token", config)).toBe(false);
    expect(isBasicAuthAuthorized("Basic bm8tY29sb24=", config)).toBe(false);
  });

  it("rejects a wrong username or password", () => {
    expect(isBasicAuthAuthorized(authorization("other", config.password), config)).toBe(false);
    expect(isBasicAuthAuthorized(authorization(config.username, "wrong"), config)).toBe(false);
  });
});
