#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { LingerClient } from "./client.js";
import { parseConfig } from "./config.js";
import { JobManager } from "./job-manager.js";
import { createLingerMcpServer } from "./server.js";
import { SessionStore } from "./session-store.js";

async function main(): Promise<void> {
  const config = parseConfig(process.env);
  const sessionStore = new SessionStore(config.sessionFile);
  const client = new LingerClient(config, sessionStore);
  const jobs = new JobManager(client, config);
  const server = createLingerMcpServer(client, jobs);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  const shutdown = async () => {
    await server.close().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  // Never write diagnostics to stdout on stdio MCP transport.
  process.stderr.write(`[linger-mcp] fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
