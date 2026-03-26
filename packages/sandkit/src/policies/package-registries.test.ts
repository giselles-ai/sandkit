import { describe, expect, test } from "bun:test";

import { bun } from "./bun";
import { allowServices } from "./dsl";
import { evaluateWorkspacePolicy } from "./evaluator";
import { npm } from "./npm";

describe("package registry service presets", () => {
  test("npm() allows the public npm registry hostname", () => {
    const policy = allowServices([npm()]);

    expect(evaluateWorkspacePolicy(policy, "https://registry.npmjs.org/react")).toMatchObject({
      allowed: true,
      matchedServiceId: "npm",
    });
  });

  test("npm() does not broaden to unrelated npm web hosts", () => {
    const policy = allowServices([npm()]);

    expect(evaluateWorkspacePolicy(policy, "https://www.npmjs.com/package/react").allowed).toBe(
      false,
    );
  });

  test("bun() allows Bun install endpoints", () => {
    const policy = allowServices([bun()]);

    expect(evaluateWorkspacePolicy(policy, "https://bun.sh/install")).toMatchObject({
      allowed: true,
      matchedServiceId: "bun",
    });
    expect(evaluateWorkspacePolicy(policy, "https://bun.com/install")).toMatchObject({
      allowed: true,
      matchedServiceId: "bun",
    });
  });
});
