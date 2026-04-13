#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { loadConfig } from '../config/index.js';
import { NexusServerFactory } from '../server/factory.js';

/**
 * Main entry point for the Nexus MCP server CLI.
 * Loads configuration, initializes the runtime via NexusServerFactory,
 * and connects to the MCP Stdio transport.
 */
async function main() {
  // Parse CLI arguments
  const { values } = parseArgs({
    options: {
      'project-root': {
        type: 'string',
      },
    },
    strict: false,
  });

  // Priority: 1. CLI flag (--project-root)
  //           2. Environment variable (NEXUS_PROJECT_ROOT)
  //           3. Current working directory (process.cwd())
  const rawProjectRoot = values['project-root'] ?? process.env.NEXUS_PROJECT_ROOT ?? process.cwd();
  const projectRoot = typeof rawProjectRoot === 'string' ? rawProjectRoot : process.cwd();

  const config = await loadConfig({ projectRoot });

  const runtime = await NexusServerFactory.createRuntime(config);

  const transport = new StdioServerTransport();
  await runtime.server.connect(transport);

  console.error(`Nexus MCP server running on stdio (root: ${projectRoot})`);

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
