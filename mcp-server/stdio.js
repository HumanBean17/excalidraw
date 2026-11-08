import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { VERSION } from "./service.js";

export const runStdioProxy = async (url) => {
  const client = new Client({
    name: "excalidraw-mcp-stdio-proxy",
    version: VERSION,
  });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  } catch (error) {
    throw new Error(
      `Cannot connect to Excalidraw MCP at ${url}. Start it with "excalidraw-mcp serve" first. ${error.message}`,
    );
  }

  const server = new Server(
    { name: "excalidraw-mcp", version: VERSION },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async (request) =>
    client.listTools(request.params),
  );
  server.setRequestHandler(CallToolRequestSchema, async (request) =>
    client.callTool(request.params),
  );

  const transport = new StdioServerTransport();
  transport.onclose = () => {
    void client.close();
  };
  await server.connect(transport);
  console.error(`excalidraw-mcp stdio proxy connected to ${url}`);
};
