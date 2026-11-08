#!/usr/bin/env node
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { createHttpService, VERSION } from "./service.js";
import { runStdioProxy } from "./stdio.js";
import { migrateLegacyDataDir } from "./store.js";

const help = `excalidraw-mcp ${VERSION}

Usage:
  excalidraw-mcp serve [--host 127.0.0.1] [--port 3845] [--data-dir PATH]
                       [--tool-profile agent|advanced]
  excalidraw-mcp stdio [--url http://127.0.0.1:3845/mcp]

Commands:
  serve   Start the persistent HTTP MCP server and browser bridge (default).
  stdio   Proxy an existing HTTP server for MCP clients that only support stdio.

Options:
  --host             Loopback address to bind (default: 127.0.0.1).
  --port             HTTP port (default: 3845).
  --data-dir         Store directory (default: ~/.excalidraw).
  --url              HTTP MCP endpoint used by the stdio proxy.
  --allowed-origins  Comma-separated additional browser origins.
  --tool-profile     Tool surface: agent (default) or advanced (includes raw tools).
  --help             Show this help.
  --version          Show the version.

Environment:
  EXCALIDRAW_MCP_HOST, EXCALIDRAW_MCP_PORT, EXCALIDRAW_MCP_DATA_DIR,
  EXCALIDRAW_MCP_URL, EXCALIDRAW_MCP_ALLOWED_ORIGINS,
  EXCALIDRAW_MCP_TOOL_PROFILE
`;

const takeValue = (args, index, option) => {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${option} requires a value`);
  }
  return value;
};

const parseArgs = (argv) => {
  const args = [...argv];
  const command = args[0] && !args[0].startsWith("--") ? args.shift() : "serve";
  if (!["serve", "stdio"].includes(command)) {
    throw new Error(`Unknown command: ${command}`);
  }
  const options = { command };
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (option === "--help") {
      options.help = true;
    } else if (option === "--version") {
      options.version = true;
    } else if (
      [
        "--host",
        "--port",
        "--data-dir",
        "--url",
        "--allowed-origins",
        "--tool-profile",
      ].includes(option)
    ) {
      options[option.slice(2)] = takeValue(args, index, option);
      index += 1;
    } else {
      throw new Error(`Unknown option: ${option}`);
    }
  }
  return options;
};

const main = async () => {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(help);
    return;
  }
  if (options.version) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }

  if (options.command === "stdio") {
    const url =
      options.url ??
      process.env.EXCALIDRAW_MCP_URL ??
      "http://127.0.0.1:3845/mcp";
    await runStdioProxy(url);
    return;
  }

  const host = options.host ?? process.env.EXCALIDRAW_MCP_HOST ?? "127.0.0.1";
  if (!["127.0.0.1", "localhost", "::1"].includes(host)) {
    throw new Error(
      "Only loopback hosts are supported; do not expose the unauthenticated server to a network",
    );
  }
  const port = Number(options.port ?? process.env.EXCALIDRAW_MCP_PORT ?? 3845);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid port: ${options.port}`);
  }
  const configuredDataDir =
    options["data-dir"] ?? process.env.EXCALIDRAW_MCP_DATA_DIR;
  const dataDir = resolve(configuredDataDir ?? join(homedir(), ".excalidraw"));
  if (configuredDataDir === undefined) {
    const legacyDataDir = join(homedir(), ".excalidraw-mcp");
    if (await migrateLegacyDataDir(legacyDataDir, dataDir)) {
      console.error(`Moved persistent store to ${dataDir}`);
    }
  }
  const allowedOrigins = (
    options["allowed-origins"] ??
    process.env.EXCALIDRAW_MCP_ALLOWED_ORIGINS ??
    ""
  )
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  const service = await createHttpService({
    host,
    port,
    dataDir,
    allowedOrigins,
    toolProfile:
      options["tool-profile"] ?? process.env.EXCALIDRAW_MCP_TOOL_PROFILE,
  });
  console.error(`excalidraw-mcp ${VERSION} listening at ${service.origin}/mcp`);
  console.error(`Persistent store: ${dataDir}`);

  let stopping = false;
  const stop = async () => {
    if (stopping) {
      return;
    }
    stopping = true;
    await service.close();
  };
  process.on("SIGINT", () => void stop());
  process.on("SIGTERM", () => void stop());
};

main().catch((error) => {
  console.error(`excalidraw-mcp: ${error.message}`);
  process.exitCode = 1;
});
