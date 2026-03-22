import { Sandbox } from "../packages/sandkit/node_modules/@vercel/sandbox";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readTimeoutMs(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

async function main() {
  const configuredTimeoutMs = 20 * 60_000;
  const sandbox = await Sandbox.create({
    runtime: "node24",
    timeout: configuredTimeoutMs,
  });

  try {
    const firstObservedAt = new Date().toISOString();
    const firstTimeoutMs = readTimeoutMs(sandbox.timeout);

    await sleep(1_000);

    const secondObservedAt = new Date().toISOString();
    const secondTimeoutMs = readTimeoutMs(sandbox.timeout);

    console.log(
      JSON.stringify(
        {
          sandboxId: sandbox.sandboxId,
          configuredTimeoutMs,
          first: {
            observedAt: firstObservedAt,
            timeoutMs: firstTimeoutMs,
          },
          second: {
            observedAt: secondObservedAt,
            timeoutMs: secondTimeoutMs,
          },
          deltaMs:
            firstTimeoutMs === null || secondTimeoutMs === null
              ? null
              : secondTimeoutMs - firstTimeoutMs,
        },
        null,
        2,
      ),
    );
  } finally {
    await sandbox.stop().catch((error) => {
      console.error("Failed to stop sandbox", error);
    });
  }
}

await main();
