# Distribution

This document is the canonical human-facing guide for distributing Nexus as the internal Claude Code plugin mirror.

The current distribution path mirrors a released Nexus source snapshot from GitHub to a private Bitbucket Cloud repository and can update the internal plugin marketplace catalog.

## Distribution flow

```text
GitHub Release
  -> Deploy plugin to Bitbucket workflow
  -> validate release source
  -> stage plugin source mirror
  -> validate plugin manifest
  -> force-push Bitbucket mirror main
  -> push release tag when absent
  -> optionally update marketplace catalog
```

The workflow is `.github/workflows/deploy-plugin-to-bitbucket.yml` and is run manually with `workflow_dispatch`.

The workflow uses the latest GitHub Release as its source. If no GitHub Release exists, deployment fails.

## Required repository configuration

### Actions secrets

| Secret | Purpose |
| --- | --- |
| `BITBUCKET_API_TOKEN` | Repository write access for the Bitbucket plugin mirror. |
| `BITBUCKET_MARKETPLACE_TOKEN` | Optional write access used to update the marketplace catalog during deployment. If absent, marketplace update is skipped. |

`BITBUCKET_API_TOKEN` and `BITBUCKET_MARKETPLACE_TOKEN` are separate credentials and should remain separate.

The marketplace update workflow may also use a GitHub `GH_PAT` when it needs to read a private plugin source repository. If that source repository is public, the normal GitHub Actions token can be sufficient.

### Actions variables

The deploy workflow expects repository variables rather than hard-coded repository locations:

- `BITBUCKET_WORKSPACE_NAME`
- `BITBUCKET_PLUGIN_REPOSITORY_NAME`
- `BITBUCKET_MARKETPLACE_REPOSITORY_NAME` when marketplace updates are enabled
- `PLUGIN_NAME`
- `PLUGIN_DESCRIPTION`
- optional embedding build variables:
  - `NEXUS_EMBEDDING_REGION`
  - `NEXUS_EMBEDDING_PROFILE`
  - `NEXUS_EMBEDDING_MODEL`
  - `NEXUS_EMBEDDING_DIMENSIONS`

Do not place Bitbucket tokens or AWS credentials in tracked files.

## Bitbucket repository token

Create a repository access token for the target private Bitbucket repository with repository write permission. Store the token in GitHub Actions as `BITBUCKET_API_TOKEN`.

The workflow uses this token through `GIT_ASKPASS`; it is not embedded in the committed remote URL.

## Marketplace token

When automatic marketplace updates are required, provide `BITBUCKET_MARKETPLACE_TOKEN` with write access to the marketplace catalog repository.

If the token is not configured, the plugin mirror deployment can still succeed; the marketplace catalog update step reports that it was skipped. In that case, run the separate marketplace update workflow after configuring the required credential.

## AWS credentials for package mode

Package mode uses the AWS Bedrock embedding provider. Machines that run the packaged plugin therefore need AWS credentials resolvable by the normal AWS SDK credential chain, for example:

- environment IAM access keys;
- AWS SSO login;
- a named AWS profile;
- an attached IAM role.

See [Embedding configuration](configuration/embedding.md) and [Runtime configuration](configuration/runtime.md) for the current package-mode and Bedrock settings.

## What the deployment workflow verifies

Before pushing the Bitbucket mirror, the workflow:

1. resolves the latest GitHub Release tag;
2. checks whether the same Bitbucket tag already exists;
3. checks out that GitHub Release;
4. checks out helper scripts from the default branch;
5. uses Node.js 24;
6. runs `npm ci`;
7. runs `npm run lint` and `npm run test`;
8. runs `scripts/stage-plugin-dist.sh dist-staging`;
9. copies the staged mirror and confirms it can install dependencies and build independently;
10. validates the staged Claude Code plugin manifest;
11. pushes the staged source mirror to Bitbucket `main`;
12. pushes the release tag when it is not already present;
13. optionally updates the marketplace catalog.

If Bitbucket is already at the latest release tag, the workflow exits without redeploying.

## Source mirror contents

The source mirror is intentionally self-contained for plugin setup and rebuilds. It contains the plugin manifest, package metadata/lockfile, TypeScript configuration, source tree, dashboard source needed by the package, plugin setup script, the Claude Code Skill at `skills/code-search/SKILL.md`, and license/notice files. The staging script generates that Skill from the repository's single source of truth at `skills/code-search/SKILL.md`.

Development-only and repository-maintenance material is not part of the plugin source mirror, including CI configuration, tests, local build output, local Nexus state, repository documentation, and agent/specification documents other than the generated `skills/code-search/SKILL.md` plugin Skill.

The exact staging policy is implemented by `scripts/stage-plugin-dist.sh`; treat that script, not a copied file list in this guide, as the machine-executable source of truth.

## Installing from the internal marketplace

The internal marketplace repository references the Bitbucket plugin source. The exact marketplace name and repository are organization configuration rather than hard-coded Nexus documentation.

A typical Claude Code flow is:

```text
/plugin marketplace add git@bitbucket.org:<workspace>/<marketplace-repository>.git
/plugin install <plugin>@<marketplace>
/reload-plugins
```

Use the actual organization-managed marketplace/plugin names.

Because the plugin source mirror is private, the user machine must have Bitbucket Git access. The current marketplace source uses an SSH-style Bitbucket URL, so configure an SSH key/agent and `known_hosts` for `bitbucket.org` before installation.

Node.js 24 or later and the native build toolchain required by dependencies must also be available on the user machine.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| `BITBUCKET_API_TOKEN not set` | Configure the GitHub Actions secret for repository write access. |
| `No releases found` | Create the intended GitHub Release before running deployment. |
| Build fails in the staged mirror | Run `npm ci` and `npm run build` from a clean checkout and inspect the staging script. |
| Plugin does not appear in the marketplace | Confirm the marketplace update credential/configuration and inspect the catalog entry. |
| `terminal prompts disabled` while cloning Bitbucket | Configure non-interactive SSH or credential-helper access for the private repository. |
| Claude Code install cannot clone the source | Verify SSH access to `bitbucket.org` and the marketplace entry's source URL. |

## Related documentation

- [Setup](setup.md)
- [Configuration](configuration.md)
- [Observability](observability/README.md)
- [Current technical specification](../SPEC.md)
