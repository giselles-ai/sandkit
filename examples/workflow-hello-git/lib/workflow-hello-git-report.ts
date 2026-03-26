import { z } from "zod";

const workflowPrReviewArtifactSchema = z.object({
  path: z.string(),
  description: z.string(),
});

const workflowPrReviewCheckSchema = z.object({
  label: z.string(),
  command: z.string(),
  outcome: z.enum(["succeeded", "failed", "not_run"]),
  note: z.string().nullable(),
});

const workflowPrReviewReportSchema = z.object({
  summary: z.string(),
  checks: z.array(workflowPrReviewCheckSchema),
  notes: z.array(z.string()).nullable(),
  files: z.array(workflowPrReviewArtifactSchema).nullable(),
});

export const REPORT_PATH = "repo/.codex/pr-verification.report.json";
export const STDOUT_PATH = "repo/.codex/codex.stdout.ndjson";
export const STDERR_PATH = "repo/.codex/codex.stderr.log";
export const SCHEMA_PATH = "repo/.codex/report.schema.json";

export type WorkflowPrReviewArtifact = z.infer<typeof workflowPrReviewArtifactSchema>;
export type WorkflowPrReviewCheck = z.infer<typeof workflowPrReviewCheckSchema>;
export type WorkflowPrReviewReport = z.infer<typeof workflowPrReviewReportSchema>;

function toStrictJsonSchema(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => toStrictJsonSchema(item));
  }

  if (value === null || typeof value !== "object") {
    return value;
  }

  const record = Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, toStrictJsonSchema(child)]),
  ) as Record<string, unknown>;

  const anyOf = Array.isArray(record.anyOf) ? record.anyOf : null;
  if (anyOf && anyOf.length === 2) {
    const typeEntries = anyOf
      .map((entry) => {
        if (entry && typeof entry === "object" && !Array.isArray(entry)) {
          const nested = entry as Record<string, unknown>;
          return typeof nested.type === "string" ? nested.type : null;
        }
        return null;
      })
      .filter((entry): entry is string => entry !== null);

    if (typeEntries.length === 2 && typeEntries.includes("null")) {
      const nonNullSchema = anyOf.find((entry) => {
        return (
          entry &&
          typeof entry === "object" &&
          !Array.isArray(entry) &&
          (entry as Record<string, unknown>).type !== "null"
        );
      });

      if (nonNullSchema && typeof nonNullSchema === "object" && !Array.isArray(nonNullSchema)) {
        return {
          ...(nonNullSchema as Record<string, unknown>),
          type: typeEntries,
        };
      }
    }
  }

  return record;
}

export function buildWorkflowPrReviewSchemaJson(): string {
  const jsonSchema = toStrictJsonSchema(z.toJSONSchema(workflowPrReviewReportSchema)) as Record<
    string,
    unknown
  >;
  delete jsonSchema.$schema;
  return JSON.stringify(jsonSchema);
}

export function parseWorkflowPrReviewReport(raw: string): WorkflowPrReviewReport | null {
  if (!raw.trim()) {
    return null;
  }

  try {
    return workflowPrReviewReportSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function buildWorkflowPrReviewPrompt(pr: { url: string }): string {
  return [
    `You are verifying GitHub pull request ${pr.url} inside an isolated sandbox.`,
    "",
    "Goal:",
    "- Find and run reasonable CI-like commands for this repository.",
    "- Install dependencies when needed.",
    "- Attempt formatter, linter, type-check, and test checks where they exist.",
    "- You are running with codex exec --yolo, so the outer sandbox is the real execution boundary.",
    "- Return a strict JSON object matching this schema:",
    "  - summary: string",
    "  - checks: array of objects with label, command, outcome, and note (use null when there is no note)",
    "  - notes: array of caveats, or null when there are none",
    "  - files: array of interesting file paths with description, or null when there are none",
    "",
    "Rules:",
    "- Do not ask for confirmation and do not request more input from the user.",
    "- Each check must include the actual shell command you decided to run or attempted to run.",
    "- If a command cannot be run, record a failed or not_run check with a short note.",
    "- Do work directly in this checkout and keep a brief, truthful summary.",
    "",
    "The repository checkout is the current working tree.",
  ].join("\n");
}
