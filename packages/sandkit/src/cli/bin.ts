#!/usr/bin/env node

import { runCli } from "./index.js";

const args = process.argv.slice(2);

try {
  const result = await runCli(args);
  if (result.outputTarget === "stdout") {
    process.stdout.write(`${result.payload.schemaText}\n`);
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
