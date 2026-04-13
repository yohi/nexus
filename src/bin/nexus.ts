#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { loadConfig } from '../config/index.js';
import { NexusServerFactory } from '../server/factory.js';
import type { NexusRuntime } from '../server/index.js';

/**
 * Main entry point for the Nexus MCP server CLI.
 * Loads configuration, initializes the runtime via NexusServerFactory,
 * and connects to the MCP Stdio transport.
 */
async function main() {
  const projectRoot = parseProjectRoot();
  const config = await loadConfig({ projectRoot });
  const runtime = await NexusServerFactory.createRuntime(config);

  const transport = new StdioServerTransport();
  await runtime.server.connect(transport);

  console.error(`Nexus MCP server running on stdio (root: ${projectRoot})`);

  setupSignalHandlers(runtime);
}

/**
 * Resolves the project root from CLI arguments, environment variables, or CWD.
 */
function parseProjectRoot(): string {
  const { values } = parseArgs({
    options: {
      'project-root': {
        type: 'string',
      },
    },
    strict: false,
  });

  const raw = values['project-root'] ?? process.env.NEXUS_PROJECT_ROOT ?? process.cwd();
  return typeof raw === 'string' ? raw : process.cwd();
}

/**
 * Configures handlers for graceful shutdown.
 */
function setupSignalHandlers(runtime: NexusRuntime): void {
  const handleShutdown = () => {
    runtime.close()
      .then(() => {
        process.exit(0);
      })
      .catch((error) => {
        console.error('Error during shutdown:', error);
        process.exit(1);
      });
  };

  process.on('SIGINT', handleShutdown);
  process.on('SIGTERM', handleShutdown);
}

main().catch((error) => {
  console.error('Fatal error starting Nexus:', error);
  process.exit(1);
});
