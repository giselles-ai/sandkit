import { createSandkit } from "@giselles-ai/sandkit";
import type { Sandkit } from "@giselles-ai/sandkit";
import { vercelSandbox } from "@giselles-ai/sandkit/integrations/vercel";

let sandkitPromise: Promise<Sandkit> | null = null;

export async function getSandkit(): Promise<Sandkit> {
  if (!sandkitPromise) {
    sandkitPromise = (async () => {
      return createSandkit({
        sandbox: vercelSandbox(),
      });
    })();
  }

  return sandkitPromise;
}
