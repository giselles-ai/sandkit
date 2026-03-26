import { allowAll, createSandkit } from "@giselles-ai/sandkit";
import { vercelSandbox } from "@giselles-ai/sandkit/integrations/vercel";

export const sandkit = createSandkit({
  setup: {
    command: "npm",
    args: ["install", "-g", "@openai/codex"],
    policy: allowAll(),
  },
  sandbox: vercelSandbox({
    runtime: "node24",
  }),
});
