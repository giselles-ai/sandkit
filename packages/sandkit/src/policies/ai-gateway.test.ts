import { afterEach, describe, expect, test } from "bun:test";

import { aiGateway } from "./ai-gateway";

describe("aiGateway", () => {
  const originalBaseUrl = process.env.AI_GATEWAY_BASE_URL;

  afterEach(() => {
    process.env.AI_GATEWAY_BASE_URL = originalBaseUrl;
  });

  test("derives allowed domains from the configured AI Gateway base URL hostname", () => {
    const policy = aiGateway({ baseUrl: "https://api.example.com:8443/v1" });

    expect(policy.domains).toEqual(["api.example.com", "*.api.example.com"]);
  });

  test("falls back to AI_GATEWAY_BASE_URL and strips ports from allow-list domains", () => {
    process.env.AI_GATEWAY_BASE_URL = "https://env.example.net:9443/gateway";
    const policy = aiGateway();

    expect(policy.domains).toEqual(["env.example.net", "*.env.example.net"]);
  });

  test("uses default credential source for Authorization header", () => {
    const policy = aiGateway({ baseUrl: "https://api.example.com" });

    expect(policy.headers?.[0].headerName).toBe("authorization");
    expect(policy.headers?.[0].valuePrefix).toBe("Bearer ");
    expect(policy.headers?.[0].credential).toEqual({ kind: "default" });
  });
});
