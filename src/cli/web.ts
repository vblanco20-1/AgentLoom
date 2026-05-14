import { EventBus } from "../bus/EventBus.ts";
import { startHttpServer } from "../server/http.ts";

export interface WebOptions {
  port: number;
  runsDir: string;
}

export async function webCli(opts: WebOptions): Promise<number> {
  const bus = new EventBus();
  const server = await startHttpServer({ port: opts.port, runsDir: opts.runsDir }, bus);
  process.stderr.write(`agent-runner web (read-only) listening on ${server.url}\n`);
  process.stderr.write(`open ${server.url}/runs to browse history\n`);
  // Block forever.
  await new Promise(() => {});
  return 0;
}
