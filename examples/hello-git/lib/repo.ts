function requireEnvVar(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}. Set ${name} and run again.`);
  }
  return value;
}

const DEFAULT_GITHUB_REPO = "giselles-ai/sandkit";

export function resolveGithubRepo(): string {
  const value = process.env.GITHUB_REPO?.trim() || DEFAULT_GITHUB_REPO;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) {
    throw new Error("GITHUB_REPO must be in `org/name` format.");
  }
  return value;
}

export function requireGithubRepo(): void {
  resolveGithubRepo();
}

export function requireGithubToken(): string {
  return requireEnvVar("GITHUB_TOKEN");
}
