# Setup

This guide is for people installing or connecting Nexus. AI-agent behavioral rules belong in [AGENTS.md](../AGENTS.md), not in this document.

## Requirements

- Node.js 24 or later
- npm
- An embedding provider
- For the default Ollama provider, a reachable Ollama service and the configured embedding model

Nexus supports two installation modes. Choose the mode that matches how you will run it.

## Source Build

Use this when developing Nexus itself or when you need a source checkout.

```bash
git clone https://github.com/yohi/nexus.git
cd nexus
npm ci
npm run build
node dist/bin/nexus.js
```

The package lockfile is authoritative for dependency resolution.

## Package Usage

`@yohi/nexus` is published to GitHub Packages (`https://npm.pkg.github.com`). Configure npm authentication for the `@yohi` scope before installing or executing the published package.

A typical project-level `.npmrc` entry is:

```ini
@yohi:registry=https://npm.pkg.github.com
```

Provide the GitHub Packages credential through npm's normal credential configuration for your environment; do not commit tokens to the repository.

After the registry is configured:

```bash
npx @yohi/nexus
```

For a tokenless source-based dependency, the repository can also be installed through its Git URL:

```bash
npm install github:yohi/nexus
```

Package deployments can use `NEXUS_PACKAGE_MODE=1`. Package mode applies additional distribution constraints, including the configured embedding-provider requirements. See [Configuration](configuration.md) and [Distribution](distribution.md).

## MCP Client Setup

For a client that can start a stdio MCP server, configure the command for the
installation mode you selected. A Source Build checkout should invoke the
built entry point with `node` and the checkout's `dist/bin/nexus.js`; it must
not assume that a cloned checkout exposes a global `nexus` command. Package
Usage can invoke `npx @yohi/nexus` after registry authentication is configured.

Example shape:

```json
{
  "mcpServers": {
    "nexus": {
      "command": "node",
      "args": ["<nexus-checkout>/dist/bin/nexus.js"],
      "env": {
        "NEXUS_STORAGE_ROOT_DIR": "/path/to/project/.nexus"
      }
    }
  }
}
```

Do not copy example paths literally; use the project you intend to index.

For stdio-only clients that need to connect through local HTTP, use:

```bash
nexus http-bridge
```

The bridge discovers or starts the project-scoped local HTTP server and forwards JSON-RPC over Streamable HTTP.

## Verify the Installation

After the MCP connection is established:

1. Call `index_status`.
2. Confirm `pipelineProgress.lastError` is absent.
3. Wait for `indexStats.lastIndexedAt` to become non-null before treating initial indexing as complete.
4. Run a small `grep_search` or `hybrid_search` query and confirm it returns project results.

Record this gate as `MCP: connected` only after all four checks pass.

Initial indexing runs in the background. Searches remain available while it is running, but may be incomplete.

## Verify the Skill

The repository Skill is `.agents/skills/code-search.md`. Confirm that the file
is available from the checkout or fetch it from:

`https://raw.githubusercontent.com/yohi/nexus/master/.agents/skills/code-search.md`

Read the file into the current agent context and confirm that its code-search
workflow is available for the setup task. Record this gate as `Skill: loaded`.
Do not copy it into a vendor-specific global directory. Setup is complete only
when both gates pass; report Skill failure separately from MCP failure.

## Next Steps

- [MCP tool reference](mcp-tools.md)
- [Configuration reference](configuration.md)
- [Current technical specification](../SPEC.md)
- [Distribution and operator workflow](distribution.md)
