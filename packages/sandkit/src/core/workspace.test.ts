import { describe, expect, test } from "bun:test";

import { allowServices } from "../policies/dsl.ts";
import { sandkit } from "./sandkit.ts";

describe("Workspace session policy lifecycle", () => {
  test("restores session policy override when reattaching to an active session", async () => {
    const defaultPolicy = allowServices([
      {
        id: "bootstrap",
        name: "Bootstrap",
        domains: ["bootstrap.example.com"],
      },
    ]);
    const livePolicy = allowServices([
      {
        id: "live",
        name: "Live",
        domains: ["live.example.com"],
      },
    ]);

    const app = sandkit();
    const workspace = await app.createWorkspace({ policy: defaultPolicy });
    const session = await workspace.sandbox.openSession();

    const before = await session.exec("policy-id");
    expect(before.stdout.trim()).toBe("allow-services:bootstrap");

    await session.setPolicy(livePolicy);
    const whileSetLive = await session.exec("policy-id");
    expect(whileSetLive.stdout.trim()).toBe("allow-services:live");

    const reloadedWorkspace = await app.getWorkspace(workspace.id);
    const reattachedSession = await reloadedWorkspace.sandbox.attachSession();
    const afterReattach = await reattachedSession.exec("policy-id");
    expect(afterReattach.stdout.trim()).toBe("allow-services:live");
  });
});
