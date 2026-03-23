import { spawnSync } from "node:child_process";

function run(command, label, { required = false } = {}) {
  console.log(`[smoke:all] running ${label}...`);

  const child = spawnSync(command, {
    shell: true,
    stdio: "inherit",
  });

  const code = child.status ?? 1;
  if (code !== 0) {
    console.error(`[smoke:all] ${label} failed with code ${code}`);
    if (required) {
      return { ok: false, code };
    }
  } else {
    console.log(`[smoke:all] ${label} passed`);
  }

  return { ok: code === 0, code };
}

const isVercelAuthConfigured =
  Boolean(process.env.VERCEL_OIDC_TOKEN) || Boolean(process.env.VERCEL_ACCESS_TOKEN);
const isCodexCredentialConfigured = Boolean(process.env.CODEX_API_KEY);

const drizzleResult = run("bun run smoke:drizzle-sample", "drizzle sample smoke", {
  required: true,
});
const drizzleKitResult = run("bun run smoke:drizzle", "legacy drizzle smoke", { required: true });
const policyResult = run("bun run --cwd smoke/vercel-sandbox smoke:policy", "policy smoke", {
  required: true,
});
const policyCredentialsResult = run(
  "bun run --cwd smoke/vercel-sandbox smoke:policy-credentials",
  "policy credentials smoke",
  { required: true },
);
const corruptionResult = run(
  "bun run --cwd smoke/vercel-sandbox smoke:corruption",
  "corruption smoke",
  { required: true },
);
const sharedSetupResult = run(
  "bun run --cwd smoke/vercel-sandbox smoke:shared-setup",
  "shared setup smoke",
  { required: true },
);
let vercelResult = { ok: true, code: 0 };
let codexExecResult = { ok: true, code: 0 };

if (isVercelAuthConfigured) {
  vercelResult = run("bun run smoke:vercel-sandbox", "Vercel sandbox smoke", { required: false });
} else {
  console.log(
    "[smoke:all] skipping Vercel sandbox smoke: set VERCEL_OIDC_TOKEN (local) or VERCEL_ACCESS_TOKEN (CI) to run it.",
  );
}

if (isVercelAuthConfigured && isCodexCredentialConfigured) {
  codexExecResult = run("bun run --cwd smoke/vercel-sandbox smoke:codex-exec", "codex exec smoke", {
    required: false,
  });
} else {
  const missing = [];
  if (!isVercelAuthConfigured) {
    missing.push("VERCEL_OIDC_TOKEN or VERCEL_ACCESS_TOKEN");
  }
  if (!isCodexCredentialConfigured) {
    missing.push("CODEX_API_KEY");
  }
  console.log(`[smoke:all] skipping codex exec smoke: set ${missing.join(" and ")} to run it.`);
}

const failed =
  !drizzleResult.ok ||
  !drizzleKitResult.ok ||
  !policyResult.ok ||
  !policyCredentialsResult.ok ||
  !corruptionResult.ok ||
  !sharedSetupResult.ok ||
  !vercelResult.ok ||
  !codexExecResult.ok;
if (failed) {
  process.exitCode = 1;
  if (!vercelResult.ok && !isVercelAuthConfigured) {
    process.exitCode = 1;
  }
}
