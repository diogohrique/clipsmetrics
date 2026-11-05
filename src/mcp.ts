#!/usr/bin/env node
// Servidor MCP local (stdio). Usa o token salvo por `npm run auth`; sem ele, lê a página pública.
import { access } from "node:fs/promises";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { configDir, getAccessToken } from "./sources/googleAuth.js";
import { fetchPublicShorts } from "./sources/youtubePublic.js";
import { registerTools } from "./tools.js";

async function hasOAuth(): Promise<boolean> {
  try {
    await access(join(configDir(), "token.json"));
    return true;
  } catch {
    return false;
  }
}

const server = new McpServer({ name: "clipmetrics", version: "0.3.0" });
registerTools(server, {
  youtube: (await hasOAuth()) ? getAccessToken : null,
  publicShorts: (id) => fetchPublicShorts(id),
  defaultChannel: process.env.CLIPMETRICS_YT_CHANNEL,
  historyStart: process.env.CLIPMETRICS_HISTORY_START,
  cache: new Map(),
});
await server.connect(new StdioServerTransport());
