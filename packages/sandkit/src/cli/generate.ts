import { writeFileSync } from "node:fs";

import { createGeneratePayload } from "../schema/generate";
import { createModelSnapshot } from "../schema/model";
import { resolveProviderWithDiscovery } from "./discovery";
import type {
  SandkitGenerateArgs,
  SandkitGenerateResolvedArgs,
  SandkitGenerateResult,
} from "./types";

function usage() {
  return [
    "Usage: sandkit generate [--adapter drizzle] [--provider <sqlite|postgresql|mysql>] [--out <file>] [--stdout]",
    "Example: npx sandkit generate --provider sqlite --stdout",
    "Example: npx sandkit generate --adapter drizzle --provider sqlite --stdout",
    "If --stdout is omitted, output is shown to console by default.",
    "Default output file: sandkit-schema.<provider>.ts",
  ].join("\n");
}

export function parseGenerateArgs(argv: string[]): SandkitGenerateArgs {
  let provider: SandkitGenerateArgs["provider"];
  let adapter: SandkitGenerateArgs["adapter"];
  let out: string | undefined;
  let stdout = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--adapter") {
      const next = argv[i + 1];
      if (next === "drizzle") {
        adapter = next;
        i++;
        continue;
      }
      throw new Error("Unsupported --adapter value. Use --adapter drizzle.");
    }
    if (arg === "--provider") {
      const next = argv[i + 1];
      if (next === "sqlite" || next === "postgresql" || next === "mysql") {
        provider = next;
        i++;
        continue;
      }
      throw new Error(`Invalid provider: ${next}`);
    }
    if (arg === "--out") {
      const next = argv[i + 1];
      if (!next) {
        throw new Error("Missing --out path");
      }
      out = next;
      i++;
      continue;
    }
    if (arg === "--stdout") {
      stdout = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      throw new Error(usage());
    }
    if (arg === "generate") {
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }

  return {
    provider,
    adapter,
    out,
    stdout,
  };
}

export function runGenerateCommand(options: SandkitGenerateResolvedArgs): SandkitGenerateResult {
  const snapshot = createModelSnapshot(options.provider);
  const payload = createGeneratePayload(options.provider, snapshot.model);
  const outputFile = options.out ?? `sandkit-schema.${options.provider}.ts`;

  const result: SandkitGenerateResult = {
    command: "generate",
    provider: options.provider,
    outputTarget: options.stdout ? "stdout" : "file",
    outputFile: options.stdout ? null : outputFile,
    payload: {
      generatedAt: payload.generatedAt,
      summary: payload.summary,
      schemaText: payload.schemaText,
    },
  };

  if (!options.stdout) {
    writeFileSync(outputFile, payload.schemaText, "utf8");
  }

  return result;
}

export async function runCliGenerate(argv: string[]): Promise<SandkitGenerateResult> {
  const options = parseGenerateArgs(argv);
  const discovered = await resolveProviderWithDiscovery({
    provider: options.provider,
    adapter: options.adapter,
    stdout: false,
    out: options.out,
  });

  return runGenerateCommand({
    provider: discovered.provider,
    adapter: options.adapter,
    out: options.out,
    stdout: options.stdout,
  });
}
