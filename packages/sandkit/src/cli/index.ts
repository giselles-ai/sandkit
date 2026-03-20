import { parseGenerateArgs, runCliGenerate } from "./generate";
import type { SandkitCliCommand, SandkitGenerateArgs, SandkitGenerateResult } from "./types";

function buildHelp() {
  return [
    "Sandkit CLI",
    "Commands: generate",
    "",
    "  sandkit generate [--adapter drizzle] [--provider <sqlite|postgresql|mysql>] [--stdout] [--out file]",
    "",
    "When --stdout is set, output is returned in memory and printed by caller.",
  ].join("\n");
}

function parseArgs(
  argv: string[],
): { command: SandkitCliCommand; rest: string[] } & SandkitGenerateArgs {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    throw new Error(buildHelp());
  }

  const command = argv[0] as SandkitCliCommand;
  if (command !== "generate") {
    throw new Error(`Unknown command: ${command}`);
  }

  const rest = argv.slice(1);
  const commandOptions = parseGenerateArgs(rest);
  return { command, ...commandOptions, rest };
}

export type SandkitRunResult = SandkitGenerateResult;

export async function runCli(argv = process.argv.slice(2)): Promise<SandkitRunResult> {
  const parsed = parseArgs(argv);
  if (parsed.command === "generate") {
    const { rest } = parsed;
    return runCliGenerate(rest);
  }

  throw new Error(`Unhandled command: ${parsed.command}`);
}
