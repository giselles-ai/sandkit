function requireEnvVar(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}. Set ${name} and run again.`);
  }
  return value;
}

export function requireGithubRepo(): void {
  const value = requireEnvVar("GITHUB_REPO");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) {
    throw new Error("GITHUB_REPO must be in `org/name` format.");
  }
}

export function requireGithubToken(): string {
  return requireEnvVar("GITHUB_TOKEN");
}
