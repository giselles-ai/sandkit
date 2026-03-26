import type { PublicWorkspaceHandle } from "@giselles-ai/sandkit";

import {
  parseWorkflowPrReviewReport,
  REPORT_PATH,
  STDERR_PATH,
  STDOUT_PATH,
  type WorkflowPrReviewReport,
} from "@/lib/workflow-hello-git-report";

type WorkspaceLike = Pick<PublicWorkspaceHandle, "sandbox">;

type RawArtifactSnapshot = {
  reportBase64: string;
  reportExists: boolean;
  stdoutExists: boolean;
  stderrExists: boolean;
  stdoutTailBase64: string;
  stderrTailBase64: string;
};

export type WorkflowPrReviewArtifactSnapshot = {
  readonly report: WorkflowPrReviewReport | null;
  readonly reportExists: boolean;
  readonly stdoutExists: boolean;
  readonly stderrExists: boolean;
  readonly stdoutTail: string;
  readonly stderrTail: string;
};

export async function collectWorkflowPrReviewArtifacts(
  workspace: WorkspaceLike,
): Promise<WorkflowPrReviewArtifactSnapshot> {
  const result = await workspace.sandbox.runCommand("bash", [
    "-lc",
    [
      "set -euo pipefail",
      `report_exists=false; [ -f '${REPORT_PATH}' ] && report_exists=true`,
      `stdout_exists=false; [ -f '${STDOUT_PATH}' ] && stdout_exists=true`,
      `stderr_exists=false; [ -f '${STDERR_PATH}' ] && stderr_exists=true`,
      `report_base64=$(cat '${REPORT_PATH}' 2>/dev/null | base64 | tr -d '\\n')`,
      `stdout_tail_base64=$(tail -n 40 '${STDOUT_PATH}' 2>/dev/null | base64 | tr -d '\\n')`,
      `stderr_tail_base64=$(tail -n 40 '${STDERR_PATH}' 2>/dev/null | base64 | tr -d '\\n')`,
      'printf \'{"reportBase64":"%s","reportExists":%s,"stdoutExists":%s,"stderrExists":%s,"stdoutTailBase64":"%s","stderrTailBase64":"%s"}\n\' "$report_base64" "$report_exists" "$stdout_exists" "$stderr_exists" "$stdout_tail_base64" "$stderr_tail_base64"',
    ].join("\n"),
  ]);
  if (result.exitCode !== 0) {
    throw new Error(`Failed to read workflow artifacts: ${result.stderr || result.stdout}`);
  }

  const rawSnapshot = JSON.parse(result.stdout.trim()) as RawArtifactSnapshot;
  const reportRaw = rawSnapshot.reportBase64
    ? Buffer.from(rawSnapshot.reportBase64, "base64").toString("utf8")
    : "";

  return {
    report: parseWorkflowPrReviewReport(reportRaw),
    reportExists: rawSnapshot.reportExists,
    stdoutExists: rawSnapshot.stdoutExists,
    stderrExists: rawSnapshot.stderrExists,
    stdoutTail: rawSnapshot.stdoutTailBase64
      ? Buffer.from(rawSnapshot.stdoutTailBase64, "base64").toString("utf8")
      : "",
    stderrTail: rawSnapshot.stderrTailBase64
      ? Buffer.from(rawSnapshot.stderrTailBase64, "base64").toString("utf8")
      : "",
  };
}
