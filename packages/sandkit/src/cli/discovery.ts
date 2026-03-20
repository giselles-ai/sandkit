import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

import type { SandkitDialect } from "../schema/model";
import type { SandkitGenerateArgs } from "./types";

type SupportedAdapter = "drizzle";

const drizzleConfigFiles = [
  "drizzle.config.ts",
  "drizzle.config.js",
  "drizzle.config.mjs",
  "drizzle.config.cjs",
  "drizzle.config.mts",
  "drizzle.config.cts",
  "drizzle.config.json",
  "drizzle.config.yaml",
  "drizzle.config.yml",
] as const;

const drizzleDependency = "drizzle-orm";

interface ProviderEvidenceScore {
  provider: SandkitDialect;
  weight: number;
}

export interface DiscoveryEvidence {
  source: string;
  signal: string;
  provider?: SandkitDialect;
  score: number;
}

export interface DiscoveryHint {
  adapter: SupportedAdapter;
  provider: SandkitDialect;
  confidence: number;
  evidence: DiscoveryEvidence[];
  prompted: boolean;
}

function parsePackageJsonDependencies(
  packagePath: string,
  evidence: DiscoveryEvidence[],
): ProviderEvidenceScore[] {
  if (!existsSync(packagePath)) {
    return [];
  }

  let packageData: {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  } = {};
  try {
    packageData = JSON.parse(readFileSync(packagePath, "utf8"));
  } catch {
    return [];
  }

  const dependencies = { ...packageData.dependencies, ...packageData.devDependencies };
  const depNames = Object.keys(dependencies);

  if (!depNames.includes(drizzleDependency)) {
    return [];
  }

  evidence.push({
    source: "package.json",
    signal: "Dependency `drizzle-orm` found.",
    score: 1.1,
  });

  const sqliteSignals = (
    [
      ["better-sqlite3", "sqlite"],
      ["libsql", "sqlite"],
      ["@libsql/client", "sqlite"],
      ["@turso", "sqlite"],
    ] as const
  ).flatMap<ProviderEvidenceScore>(([name, provider]) =>
    depNames.some((dep) => dep.includes(name)) ? [{ provider, weight: 1.6 }] : [],
  );

  const postgresSignals = (
    [
      ["pg", "postgresql"],
      ["postgres", "postgresql"],
      ["@vercel/postgres", "postgresql"],
      ["@neondatabase/serverless", "postgresql"],
    ] as const
  ).flatMap<ProviderEvidenceScore>(([name, provider]) =>
    depNames.some((dep) => dep.includes(name)) ? [{ provider, weight: 1.6 }] : [],
  );

  const addSignals = (signals: ProviderEvidenceScore[]) =>
    signals.forEach((entry) =>
      evidence.push({
        source: "package.json",
        signal: `Dependency implies ${entry.provider} driver usage (${entry.provider} signal).`,
        provider: entry.provider,
        score: entry.weight,
      }),
    );

  addSignals(sqliteSignals);
  addSignals(postgresSignals);

  return [...sqliteSignals, ...postgresSignals];
}

function inspectDrizzleConfig(cwd: string, evidence: DiscoveryEvidence[]): ProviderEvidenceScore[] {
  const results: ProviderEvidenceScore[] = [];

  for (const filename of drizzleConfigFiles) {
    const configPath = join(cwd, filename);
    if (!existsSync(configPath)) {
      continue;
    }

    let text = "";
    try {
      text = readFileSync(configPath, "utf8");
    } catch {
      continue;
    }

    evidence.push({
      source: filename,
      signal: `Found drizzle config file: ${filename}.`,
      score: 0.6,
    });

    if (/dialect\s*:\s*["']sqlite["']/i.test(text)) {
      evidence.push({
        source: filename,
        signal: "Drizzle config sets dialect to sqlite.",
        provider: "sqlite",
        score: 3,
      });
      return [{ provider: "sqlite", weight: 3 }];
    }

    if (/dialect\s*:\s*["']postgresql["']/i.test(text)) {
      evidence.push({
        source: filename,
        signal: "Drizzle config sets dialect to postgresql.",
        provider: "postgresql",
        score: 3,
      });
      return [{ provider: "postgresql", weight: 3 }];
    }

    if (/dialect\s*:\s*["']mysql["']/i.test(text)) {
      evidence.push({
        source: filename,
        signal: "Drizzle config sets dialect to mysql.",
        provider: "mysql",
        score: 3,
      });
      return [{ provider: "mysql", weight: 3 }];
    }

    const dbUrlMatch = text.match(/url\s*:\s*["'`](.*?)["'`]/i);
    if (dbUrlMatch?.[1]) {
      const url = dbUrlMatch[1].toLowerCase();
      if (url.includes("turso") || url.includes("libsql") || url.includes("sqlite")) {
        evidence.push({
          source: filename,
          signal: "Drizzle config DB URL contains sqlite/libsql/turso hints.",
          provider: "sqlite",
          score: 2,
        });
        results.push({ provider: "sqlite", weight: 2 });
      }

      if (url.includes("postgres")) {
        evidence.push({
          source: filename,
          signal: "Drizzle config DB URL contains postgres hints.",
          provider: "postgresql",
          score: 2,
        });
        results.push({ provider: "postgresql", weight: 2 });
      }
    }
  }

  return results;
}

function collectEvidence(cwd: string): {
  evidence: DiscoveryEvidence[];
  isDrizzleProject: boolean;
} {
  const evidence: DiscoveryEvidence[] = [];
  const packageSignals = parsePackageJsonDependencies(join(cwd, "package.json"), evidence);
  const drizzleSignals = inspectDrizzleConfig(cwd, evidence);
  return {
    evidence,
    isDrizzleProject: packageSignals.length > 0 || drizzleSignals.length > 0,
  };
}

function rankProviderSignals(evidence: DiscoveryEvidence[]): {
  provider?: SandkitDialect;
  confidence: number;
} {
  const totals: Record<SandkitDialect, number> = { sqlite: 0, postgresql: 0, mysql: 0 };

  for (const item of evidence) {
    if (!item.provider) continue;
    totals[item.provider] += item.score;
  }

  const ranked = (Object.entries(totals) as [SandkitDialect, number][])
    .sort((a, b) => b[1] - a[1])
    .filter((entry) => entry[1] > 0);

  if (ranked.length === 0) {
    return { provider: undefined, confidence: 0 };
  }

  const [winner, winnerScore] = ranked[0]!;
  const secondScore = ranked[1]?.[1] ?? 0;
  const confidence = winnerScore === 0 ? 0 : winnerScore / (winnerScore + secondScore);
  return { provider: winner, confidence };
}

function promptWithChoices(question: string, options: string[], fallback: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    rl.question(question, (answer) => {
      rl.close();
      const normalized = answer.trim().toLowerCase();
      if (options.includes(normalized)) {
        resolve(normalized);
        return;
      }
      resolve(fallback);
    });
  });
}

export async function resolveProviderWithDiscovery(
  options: SandkitGenerateArgs,
  cwd = process.cwd(),
): Promise<DiscoveryHint> {
  if (options.provider) {
    if (
      options.provider !== "sqlite" &&
      options.provider !== "postgresql" &&
      options.provider !== "mysql"
    ) {
      throw new Error("Invalid provider. Use one of: sqlite, postgresql, mysql.");
    }
    return {
      adapter: "drizzle",
      provider: options.provider,
      confidence: 1,
      evidence: [
        {
          source: "cli",
          signal: `Provider explicitly set as ${options.provider}.`,
          provider: options.provider,
          score: 100,
        },
      ],
      prompted: false,
    };
  }

  if (options.adapter && options.adapter !== "drizzle") {
    throw new Error("Unsupported adapter. This release supports --adapter drizzle only.");
  }

  const { evidence, isDrizzleProject } = collectEvidence(cwd);
  const inference = rankProviderSignals(evidence);
  const adapter: SupportedAdapter = isDrizzleProject ? "drizzle" : "drizzle";

  if (!isDrizzleProject) {
    throw new Error(
      "Could not detect a drizzle project from this directory. " +
        "Run inside a Drizzle project and pass --provider/--adapter explicitly if needed.",
    );
  }

  if (inference.provider && inference.confidence >= 0.75) {
    return {
      adapter,
      provider: inference.provider,
      confidence: inference.confidence,
      evidence,
      prompted: false,
    };
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      "Could not infer database provider confidently. " +
        "Re-run with --provider <sqlite|postgresql|mysql>.",
    );
  }

  const prompt = await promptWithChoices(
    `Could not infer the database provider from repo signals.\n` +
      `Select provider [sqlite|postgresql|mysql] (default sqlite): `,
    ["sqlite", "postgresql", "mysql"],
    "sqlite",
  );
  return {
    adapter,
    provider: prompt as SandkitDialect,
    confidence: inference.confidence,
    evidence,
    prompted: true,
  };
}
