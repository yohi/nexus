# MCP and Skill Setup Design

## Goal

Make the AI-agent setup flow reliably provision and verify both parts of Nexus:

- the Nexus MCP server and its client connection;
- the repository code-search Skill.

The flow must support a generic AI coding agent and the Claude Code plugin
distribution without introducing agent-specific global installation steps.

## Scope and Boundaries

`skills/code-search/SKILL.md` remains the single source of truth for the
repository Skill. Generic agents load that file from the checked-out repository
or its GitHub Raw URL; the setup flow does not modify a user's global agent
configuration.

The Claude Code plugin staging flow generates the plugin-native Skill path from
the same source file. The generated staging copy is an artifact, not a second
source of truth.

MCP setup remains client-specific. The flow must identify the selected client,
configure the command using the selected Source Build or Package Usage mode,
and report client configuration separately from server build success.

## Setup Flow

The README prompt references the repository URL and Raw URLs for `AGENTS.md`,
`docs/setup.md`, and `skills/code-search/SKILL.md`.

`AGENTS.md` defines two independent setup gates:

1. **MCP gate**: inspect the environment, obtain the Source Build or Package
   Usage choice, install or build using `docs/setup.md`, configure the MCP
   client, call `index_status`, and run a small search query.
2. **Skill gate**: locate the repository Skill, load it into the current agent
   context, and confirm that the agent can use its workflow. A generic agent
   must report Skill availability without claiming a global installation.

The agent reports both gates separately and may only report setup complete when
both gates pass. If the client cannot be configured or the Skill cannot be
loaded, it reports the exact failed gate and a safe next action.

## Claude Code Plugin Distribution

The staging script copies `skills/code-search/SKILL.md` to the plugin-native
`skills/code-search/SKILL.md` path. The plugin source mirror therefore contains
both the existing MCP manifest and the Skill consumed by Claude Code.

The plugin manifest continues to own MCP registration and setup hooks. Skill
discovery is provided by the plugin-native directory layout, not by adding a
second Skill declaration to `plugin.json`.

## MCP Client Command Contract

The Source Build path must not assume that a cloned repository exposes a global
`nexus` executable. Client configuration uses the built entry point or an
explicitly documented local executable path. Package Usage may use
`npx @yohi/nexus` after registry authentication is configured.

The setup guide retains client-specific examples, but each example identifies
which installation mode it requires and how to verify that the configured MCP
command starts.

## Verification

Documentation tests assert that both README prompts contain all three Raw URLs
and that the setup protocol names independent MCP and Skill verification.

The plugin staging test asserts that the generated mirror contains:

- the plugin manifest;
- the MCP runtime entry point and setup hook;
- `skills/code-search/SKILL.md` with content matching the repository Skill.

The setup verification procedure checks `index_status` and a search response for
MCP, and checks Skill file availability and loading for the Skill gate. Failed
verification must never be summarized as a successful complete setup.

## Non-Goals

- Installing files into vendor-specific global agent directories.
- Duplicating Skill content in the repository.
- Replacing the existing manual setup instructions.
- Changing MCP runtime behavior or embedding-provider behavior.
