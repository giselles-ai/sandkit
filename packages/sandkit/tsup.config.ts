import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: {
      index: "src/index.ts",
      "adapters/sqlite-bun": "src/adapters/sqlite-bun.ts",
      "adapters/drizzle": "src/adapters/drizzle.ts",
      "adapters/memory": "src/adapters/memory.ts",
      "policies/codex": "src/policies/codex.ts",
      "policies/gemini": "src/policies/gemini.ts",
      "policies/ai-gateway": "src/policies/ai-gateway.ts",
      "integrations/mock": "src/integrations/mock.ts",
      "integrations/vercel": "src/integrations/vercel.ts",
      "schema/index": "src/schema/index.ts",
      "cli/index": "src/cli/index.ts",
    },
    outDir: "dist",
    format: ["esm"],
    target: "esnext",
    dts: true,
    sourcemap: true,
    external: ["drizzle-orm", "@vercel/sandbox"],
  },
  {
    entry: {
      bin: "src/cli/bin.ts",
    },
    outDir: "dist",
    format: ["esm"],
    target: "esnext",
    sourcemap: true,
    external: ["drizzle-orm", "@vercel/sandbox"],
  },
]);
