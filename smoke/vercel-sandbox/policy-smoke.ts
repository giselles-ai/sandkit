import {
  createMemoryAdapter,
  sandkit,
  allowAll,
  allowService,
  codex,
  denyAll,
  evaluateWorkspacePolicy,
} from "sandkit";

async function runSmoke(): Promise<void> {
  const app = sandkit({
    database: createMemoryAdapter(),
    policy: denyAll(),
  });

  const workspace = await app.createWorkspace({ name: "policy-smoke" });
  const initial = await workspace.sandbox.runCommand({ command: "policy-id" });
  if (initial.stdout.trim() !== "deny-all") {
    throw new Error(
      `Smoke failed: expected deny-all default policy, got "${initial.stdout.trim()}"`,
    );
  }

  await workspace.setPolicy(allowService(codex()));

  const durableDefault = await workspace.sandbox.runCommand({ command: "policy-id" });
  if (durableDefault.stdout.trim() !== "allow-services:codex") {
    throw new Error(
      `Smoke failed: expected durable default allow-services:codex, got "${durableDefault.stdout.trim()}"`,
    );
  }

  const override = await workspace.sandbox.runCommand({
    command: "policy-id",
    policy: allowAll(),
  });
  if (override.stdout.trim() !== "allow-all") {
    throw new Error(`Smoke failed: expected allow-all override, got "${override.stdout.trim()}"`);
  }

  const afterOverride = await workspace.sandbox.runCommand({ command: "policy-id" });
  if (afterOverride.stdout.trim() !== "allow-services:codex") {
    throw new Error(
      `Smoke failed: expected override to be ephemeral, got "${afterOverride.stdout.trim()}"`,
    );
  }

  const wildcardDecision = evaluateWorkspacePolicy(
    allowService({
      id: "wildcard-only",
      name: "Wildcard Only",
      domains: ["*.example.com"],
    }),
    "https://example.com",
  );
  if (wildcardDecision.allowed) {
    throw new Error("Smoke failed: *.example.com must not match example.com");
  }

  const subdomainDecision = evaluateWorkspacePolicy(
    allowService({
      id: "wildcard-only",
      name: "Wildcard Only",
      domains: ["*.example.com"],
    }),
    "https://api.example.com",
  );
  if (!subdomainDecision.allowed) {
    throw new Error("Smoke failed: *.example.com must match api.example.com");
  }

  console.log("smokePolicyWorkspaceId", workspace.id);
}

void runSmoke();
