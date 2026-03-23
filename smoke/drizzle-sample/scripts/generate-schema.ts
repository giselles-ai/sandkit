import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { runGenerateCommand } from "../internal-seams.ts";

const outputPath = join(process.cwd(), "generated", "sandkit-schema.generated.ts");
await mkdir("generated", { recursive: true });

await rm(outputPath, { force: true });
const generated = runGenerateCommand({
  provider: "sqlite",
  out: outputPath,
  stdout: false,
});

if (!generated.outputFile) {
  throw new Error("Smoke drizzle sample: Sandkit generation did not return an output file path");
}

console.log(`[smoke:drizzle-sample] generated schema at ${generated.outputFile}`);
