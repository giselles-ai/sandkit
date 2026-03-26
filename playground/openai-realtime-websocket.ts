import { Sandbox, type NetworkPolicy } from "../packages/sandkit/node_modules/@vercel/sandbox";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

function createOpenAiRealtimePolicy(apiKey: string): NetworkPolicy {
  return {
    allow: {
      "api.openai.com": [
        {
          transform: [
            {
              headers: {
                Authorization: `Bearer ${apiKey}`,
              },
            },
          ],
        },
      ],
    },
  };
}

async function main() {
  const openAiApiKey = requireEnv("OPENAI_API_KEY");
  const model = process.env.OPENAI_REALTIME_MODEL?.trim() || "gpt-realtime";
  const timeoutMs = 2 * 60_000;
  const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`;

  const sandbox = await Sandbox.create({
    runtime: "node24",
    timeout: timeoutMs,
    networkPolicy: createOpenAiRealtimePolicy(openAiApiKey),
  });

  try {
    const transportCheck = await sandbox.runCommand("node", [
      "-e",
      `
const dns = require("node:dns/promises");
const tls = require("node:tls");

async function main() {
  const lookup = await dns.lookup("api.openai.com", { all: true });
  const tlsResult = await new Promise((resolve) => {
    const socket = tls.connect({
      host: "api.openai.com",
      port: 443,
      servername: "api.openai.com",
      rejectUnauthorized: true,
    });

    socket.once("secureConnect", () => {
      resolve({
        ok: true,
        remoteAddress: socket.remoteAddress,
        remotePort: socket.remotePort,
        authorized: socket.authorized,
        authorizationError: socket.authorizationError ?? null,
        alpnProtocol: socket.alpnProtocol || null,
      });
      socket.end();
    });

    socket.once("error", (error) => {
      resolve({
        ok: false,
        error: String(error),
      });
    });
  });

  console.log(JSON.stringify({ lookup, tls: tlsResult }, null, 2));
}

main().catch((error) => {
  console.error(String(error));
  process.exit(1);
});
      `,
    ]);

    const httpsCheck = await sandbox.runCommand("sh", [
      "-lc",
      [
        "set -eu",
        "payload=$(mktemp)",
        'status=$(curl -sS -o "$payload" -w "%{http_code}" https://api.openai.com/v1/models)',
        'printf \'{"status":"%s","body":\' "$status"',
        "cat \"$payload\" | node -e \"let data = ''; process.stdin.on('data', (chunk) => data += chunk); process.stdin.on('end', () => process.stdout.write(JSON.stringify(data)))\"",
        "printf '}'",
        'rm -f "$payload"',
      ].join("\n"),
    ]);

    const passiveWebsocketScript = `
const url = ${JSON.stringify(url)};
const timeoutMs = 15000;

const ws = new WebSocket(url);
const lifecycle = [];
let finished = false;

const timer = setTimeout(() => {
  if (finished) return;
  finished = true;
  lifecycle.push({ type: "timeout" });
  try { ws.close(); } catch {}
  setTimeout(() => {
    console.error(JSON.stringify({
      ok: false,
      lifecycle,
      reason: "Timed out waiting for open/close.",
    }, null, 2));
    process.exit(2);
  }, 250);
}, timeoutMs);

ws.onopen = () => {
  if (finished) return;
  finished = true;
  clearTimeout(timer);
  lifecycle.push({ type: "open" });
  console.log(JSON.stringify({
    ok: true,
    url,
    lifecycle,
  }, null, 2));
  ws.close(1000, "passive-open");
};

ws.onerror = (event) => {
  lifecycle.push({
    type: "error",
    message: event?.message ?? null,
    error: event?.error ? String(event.error) : null,
    stack: event?.error?.stack ?? null,
  });
};

ws.onclose = (event) => {
  lifecycle.push({
    type: "close",
    code: event.code,
    reason: event.reason,
    wasClean: event.wasClean,
  });
  if (finished) {
    return;
  }
  finished = true;
  clearTimeout(timer);
  console.error(JSON.stringify({
    ok: false,
    lifecycle,
    code: event.code,
    reason: event.reason,
    wasClean: event.wasClean,
  }, null, 2));
  process.exit(1);
};
`;

    const activeWebsocketScript = `
const url = ${JSON.stringify(url)};
const timeoutMs = 15000;

function toText(data) {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  return String(data);
}

const ws = new WebSocket(url);
const seen = [];
const lifecycle = [];
let finished = false;

const timer = setTimeout(() => {
  if (finished) return;
  finished = true;
  lifecycle.push({ type: "timeout" });
  try { ws.close(); } catch {}
  setTimeout(() => {
    console.error(JSON.stringify({
      ok: false,
      lifecycle,
      seenTypes: seen.map((item) => item?.type ?? "unknown"),
      reason: "Timed out waiting for realtime events.",
    }, null, 2));
    process.exit(2);
  }, 250);
}, timeoutMs);

ws.onopen = () => {
  lifecycle.push({ type: "open" });
  try {
    const payload = JSON.stringify({
      type: "session.update",
      session: {
        instructions: "Reply with a short acknowledgement.",
      },
    });
    lifecycle.push({ type: "send.start", bytes: payload.length });
    ws.send(payload);
    lifecycle.push({ type: "send.done" });
  } catch (error) {
    lifecycle.push({
      type: "send.throw",
      error: String(error),
      stack: error instanceof Error ? error.stack ?? null : null,
    });
  }
};

ws.onmessage = (event) => {
  const raw = toText(event.data);
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = { type: "unparsed", raw };
  }

  lifecycle.push({ type: "message", eventType: parsed?.type ?? "unknown" });
  seen.push(parsed);

  if (
    parsed?.type === "session.updated" ||
    parsed?.type === "response.created" ||
    seen.length >= 3
  ) {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    console.log(JSON.stringify({
      ok: true,
      url,
      lifecycle,
      eventTypes: seen.map((item) => item?.type ?? "unknown"),
      lastEvent: parsed,
    }, null, 2));
    ws.close(1000, "done");
  }
};

ws.onerror = (event) => {
  lifecycle.push({
    type: "error",
    message: event?.message ?? null,
    error: event?.error ? String(event.error) : null,
    stack: event?.error?.stack ?? null,
  });
};

ws.onclose = (event) => {
  lifecycle.push({
    type: "close",
    code: event.code,
    reason: event.reason,
    wasClean: event.wasClean,
  });
  if (finished) return;
  finished = true;
  clearTimeout(timer);
  console.error(JSON.stringify({
    ok: false,
    lifecycle,
    seenTypes: seen.map((item) => item?.type ?? "unknown"),
    code: event.code,
    reason: event.reason,
    wasClean: event.wasClean,
  }, null, 2));
  process.exit(1);
};
`;

    const websocketPassiveCheck = await sandbox.runCommand("node", ["-e", passiveWebsocketScript]);
    const websocketActiveCheck = await sandbox.runCommand("node", ["-e", activeWebsocketScript]);

    const transportStdout = await transportCheck.stdout();
    const transportStderr = await transportCheck.stderr();
    const httpsStdout = await httpsCheck.stdout();
    const httpsStderr = await httpsCheck.stderr();
    const websocketPassiveStdout = await websocketPassiveCheck.stdout();
    const websocketPassiveStderr = await websocketPassiveCheck.stderr();
    const websocketActiveStdout = await websocketActiveCheck.stdout();
    const websocketActiveStderr = await websocketActiveCheck.stderr();

    let transportBody: unknown = null;
    try {
      transportBody = JSON.parse(transportStdout);
    } catch {
      transportBody = transportStdout;
    }

    let httpsBody: unknown = null;
    try {
      const parsed = JSON.parse(httpsStdout);
      httpsBody =
        typeof parsed.body === "string" && parsed.body.length > 0
          ? JSON.parse(parsed.body)
          : parsed.body;
    } catch {
      httpsBody = httpsStdout;
    }

    console.log(
      JSON.stringify(
        {
          sandboxId: sandbox.sandboxId,
          model,
          url,
          transport: {
            exitCode: transportCheck.exitCode,
            stdout: transportStdout,
            stderr: transportStderr,
            parsedBody: transportBody,
          },
          https: {
            exitCode: httpsCheck.exitCode,
            stdout: httpsStdout,
            stderr: httpsStderr,
            parsedBody: httpsBody,
          },
          websocketPassive: {
            exitCode: websocketPassiveCheck.exitCode,
            stdout: websocketPassiveStdout,
            stderr: websocketPassiveStderr,
          },
          websocketActive: {
            exitCode: websocketActiveCheck.exitCode,
            stdout: websocketActiveStdout,
            stderr: websocketActiveStderr,
          },
        },
        null,
        2,
      ),
    );
  } finally {
    await sandbox.stop().catch((error: unknown) => {
      console.error("Failed to stop sandbox", error);
    });
  }
}

await main();
