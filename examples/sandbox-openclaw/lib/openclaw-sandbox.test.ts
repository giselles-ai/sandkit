import { describe, expect, test } from "bun:test";

import { readSessionToken, withRetry } from "./openclaw-sandbox";

describe("openclaw sandbox retry behavior", () => {
  test("withRetry executes attempts sequentially", async () => {
    let activeAttempts = 0;
    let maxConcurrentAttempts = 0;
    let attempts = 0;

    const result = await withRetry(
      async () => {
        attempts += 1;
        activeAttempts += 1;
        maxConcurrentAttempts = Math.max(maxConcurrentAttempts, activeAttempts);
        if (attempts < 3) {
          await new Promise((resolve) => setTimeout(resolve, 20));
          activeAttempts -= 1;
          throw new Error(`retry-${attempts}`);
        }

        await new Promise((resolve) => setTimeout(resolve, 10));
        activeAttempts -= 1;
        return "ok";
      },
      5,
      1,
    );

    expect(result).toBe("ok");
    expect(attempts).toBe(3);
    expect(maxConcurrentAttempts).toBe(1);
  });

  test("readSessionToken reads token file through bash -lc and trims output", async () => {
    const exec = async (_command: string, args: string[]) => {
      expect(_command).toBe("bash");
      expect(args).toEqual(["-lc", "cat '/vercel/sandbox/home/.openclaw/auth-token.txt'"]);
      return {
        exitCode: 0,
        stdout: "abc123\n",
        stderr: "",
      };
    };

    const token = await readSessionToken({
      exec,
    } as unknown as {
      exec: (
        command: string,
        args: string[],
      ) => Promise<{
        exitCode: number;
        stdout: string;
        stderr: string;
      }>;
    });

    expect(token).toBe("abc123");
  });

  test("readSessionToken returns empty string when token read fails", async () => {
    const session = {
      exec: async () => {
        throw new Error("missing token file");
      },
    } as unknown as {
      exec: (
        command: string,
        args: string[],
      ) => Promise<{
        exitCode: number;
        stdout: string;
        stderr: string;
      }>;
    };

    const token = await readSessionToken(session);

    expect(token).toBe("");
  });
});
