# Project Nexus Auto-Connector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development`
> or `executing-plans` to implement this plan task-by-task. Steps use checkbox
> syntax for tracking.

**Goal:** Reuse one Nexus HTTP runtime per project, starting it on demand and
stopping it when its final MCP client disconnects.

**Architecture:** `nexus http-bridge` becomes a connector. It discovers a
project-local HTTP endpoint descriptor, or serializes startup and spawns a
detached managed HTTP child when none is healthy. The managed child owns the
storage locks, runtime, watcher, and HTTP listener; the connector owns only its
stdio-to-HTTP transport. Per-client MCP server instances share that runtime.

**Tech Stack:** Node.js 24+, TypeScript, `@modelcontextprotocol/sdk` 1.x,
Vitest, Node HTTP, `proper-lockfile`.

## Global Constraints

- Keep auto-managed server endpoints loopback-only; preserve explicit manual URL
  overrides without changing their existing validation contract.
- Keep stdout exclusively for stdio JSON-RPC; diagnostics go to stderr.
- Do not remove or bypass the existing process/project locks.
- Use an OS-assigned port for managed project servers; do not reserve a global
  fixed port.
- An explicit `--url` or `NEXUS_BRIDGE_URL` remains a manual override and does
  not auto-spawn a local project server.
- Do not use systemd or any external supervisor.
- Do not create a second runtime for a project whose managed endpoint is healthy.

---

### Task 1: Add project endpoint discovery and bootstrap coordination

**Files:**

- Create: `src/server/project-endpoint.ts`
- Test: `tests/unit/server/project-endpoint.test.ts`
- Modify: `src/utils/global-lock.ts`
- Test: `tests/unit/utils/global-lock.test.ts`

**Interfaces:**

- Produces `ProjectEndpoint`, `readProjectEndpoint()`,
  `writeProjectEndpoint()`, `removeProjectEndpoint()`, and
  `waitForProjectEndpoint()`.
- Produces `projectStartupLockName(storageDir: string): string`, a stable
  hash-derived lock name accepted by `acquireGlobalLock()`.
- Consumes a storage directory; never infers project identity from a bare port.

- [ ] **Step 1: Write failing endpoint tests**

```ts
it('atomically round-trips an endpoint for one storage directory', async () => {
  const endpoint = {
    instanceId: 'instance-a',
    pid: 123,
    projectRoot: '/workspace/app',
    url: 'http://127.0.0.1:43123',
  };

  await writeProjectEndpoint(storageDir, endpoint);

  await expect(readProjectEndpoint(storageDir)).resolves.toEqual(endpoint);
});

it('waits for the endpoint written by the startup winner', async () => {
  const pending = waitForProjectEndpoint(storageDir, { timeoutMs: 500 });
  await writeProjectEndpoint(storageDir, endpoint);
  await expect(pending).resolves.toEqual(endpoint);
});
```

- [ ] **Step 2: Run the endpoint test to verify it fails**

Run:

```bash
npx vitest run tests/unit/server/project-endpoint.test.ts
```

Expected: FAIL because `project-endpoint.ts` does not exist.

- [ ] **Step 3: Implement descriptor persistence and a project startup lock name**

```ts
export interface ProjectEndpoint {
  readonly instanceId: string;
  readonly pid: number;
  readonly projectRoot: string;
  readonly url: string;
}

export const PROJECT_ENDPOINT_FILENAME = 'endpoint.json';

export async function writeProjectEndpoint(
  storageDir: string,
  endpoint: ProjectEndpoint,
): Promise<void> {
  const target = join(storageDir, PROJECT_ENDPOINT_FILENAME);
  const temporary = `${target}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(endpoint)}\n`, { mode: 0o600 });
  await rename(temporary, target);
}
```

Implement `readProjectEndpoint()` as strict JSON validation returning
`undefined` for absent or malformed descriptors. Implement removal as an
idempotent unlink. Hash the canonical storage path with SHA-256 and return a
`project-start-<hex>` lock name; this prevents two different projects from
sharing a bootstrap lock.

- [ ] **Step 4: Add tests for malformed descriptors and distinct startup locks**

```ts
it('returns undefined for malformed endpoint JSON', async () => {
  await writeFile(join(storageDir, PROJECT_ENDPOINT_FILENAME), '{');
  await expect(readProjectEndpoint(storageDir)).resolves.toBeUndefined();
});

it('derives different startup locks for different storage directories', () => {
  expect(projectStartupLockName('/one')).not.toBe(projectStartupLockName('/two'));
});
```

- [ ] **Step 5: Run focused tests**

Run:

```bash
npx vitest run tests/unit/server/project-endpoint.test.ts tests/unit/utils/global-lock.test.ts
```

Expected: PASS.

### Task 2: Separate the shared runtime from per-client MCP servers

**Files:**

- Modify: `src/server/index.ts:38-56,320-474`
- Modify: `src/server/factory.ts:484-548`
- Modify: `src/server/transport.ts:10-185`
- Modify: `tests/integration/server.test.ts:89-180`
- Modify: `tests/stress/concurrent-agents.test.ts:89-160`

**Interfaces:**

- `NexusRuntime` exposes `createServer(): McpServer` rather than a reusable
  connected `server` instance.
- `createStreamableHttpHandler()` accepts optional `onSessionOpen` and
  `onSessionClose` callbacks; each callback receives the session ID.
- Runtime close remains the only operation that closes stores, watcher, and
  project lock.

- [ ] **Step 1: Write a failing multi-client shared-runtime test**

```ts
it('creates a distinct MCP server for each HTTP client while sharing tool dependencies', async () => {
  const created: McpServer[] = [];
  const handler = createStreamableHttpHandler({
    createServer: () => {
      const server = runtime.createServer();
      created.push(server);
      return server;
    },
  });

  await Promise.all([connectClient(handler), connectClient(handler)]);

  expect(created).toHaveLength(2);
  expect(created[0]).not.toBe(created[1]);
});
```

- [ ] **Step 2: Run the focused integration test to verify it fails**

Run:

```bash
npx vitest run tests/integration/server.test.ts
```

Expected: FAIL because `runtime.createServer` is unavailable or both sessions
reuse the same server instance.

- [ ] **Step 3: Refactor `NexusRuntime` to produce per-session servers**

Keep the shared dependencies constructed by `createNexusRuntime()`. Retain the
existing `createNexusServer(options, awaitInitialize)` call as a factory closure
instead of calling it once during runtime construction.

```ts
const createServer = (): McpServer => createNexusServer(serverOptions, initialize);

return {
  createServer,
  orchestrator,
  sanitizer,
  initialize,
  close,
  reindex,
  registrationClient,
};
```

Update stdio startup to call `runtime.createServer()` once. Update HTTP startup
to pass `createServer: runtime.createServer`.

- [ ] **Step 4: Add session lifecycle callbacks to the HTTP transport**

Call `onSessionOpen` exactly after a session ID is assigned. Call
`onSessionClose` exactly once from idle cleanup, transport close, and initial
connection failure paths. Do not call `runtime.close()` from these callbacks.

- [ ] **Step 5: Run integration and stress tests**

Run:

```bash
npx vitest run tests/integration/server.test.ts tests/stress/concurrent-agents.test.ts
```

Expected: PASS, including two simultaneous clients.

### Task 3: Add managed HTTP server lifecycle

**Files:**

- Create: `src/server/managed-http-server.ts`
- Test: `tests/unit/server/managed-http-server.test.ts`
- Modify: `src/bin/nexus.ts:16-183`
- Modify: `src/server/project-endpoint.ts`

**Interfaces:**

- Produces `startManagedHttpServer(options): Promise<ManagedHttpServer>`.
- `ManagedHttpServer` exposes `url`, `instanceId`, `closed`, and `close()`.
- Adds hidden CLI option `--managed` for children spawned by the connector.
- `--port 0 --managed` is valid; public `--port` remains valid for 1–65535.

- [ ] **Step 1: Write failing lifecycle tests**

```ts
it('writes the resolved loopback endpoint after listening', async () => {
  const server = await startManagedHttpServer(options);

  await expect(readProjectEndpoint(storageDir)).resolves.toMatchObject({
    pid: process.pid,
    projectRoot,
    url: server.url.toString(),
  });

  await server.close();
});

it('closes the runtime and removes the descriptor after the final session closes', async () => {
  const server = await startManagedHttpServer({ ...options, idleShutdownMs: 0 });
  await connectAndCloseClient(server.url);

  await server.closed;
  await expect(readProjectEndpoint(storageDir)).resolves.toBeUndefined();
});
```

- [ ] **Step 2: Run the lifecycle test to verify it fails**

Run:

```bash
npx vitest run tests/unit/server/managed-http-server.test.ts
```

Expected: FAIL because the managed server module does not exist.

- [ ] **Step 3: Implement managed listener, readiness, and idle shutdown**

Create a Node HTTP server on `127.0.0.1` and requested port `0`. Expose
`GET /health` returning the endpoint instance ID and project root. Route other
requests through `createStreamableHttpHandler({ createServer: runtime.createServer })`.

Track open session IDs using the new callbacks. After the final close, schedule
one idempotent shutdown that closes the HTTP listener, closes the shared runtime,
removes `endpoint.json`, releases `nexus.pid`, and exits only in CLI ownership.
Use a bounded startup grace timer so an orphaned detached child exits if no
connector reaches it.

- [ ] **Step 4: Wire managed mode into the CLI**

Add `managed: { type: 'boolean' }` to `parseArgs`. For `--port`, allow port 0
only if `--managed` is true. Replace the inline HTTP listener with the managed
server helper. Keep `--port <1..65535>` available for explicit administration.

- [ ] **Step 5: Run focused tests**

Run:

```bash
npx vitest run tests/unit/server/managed-http-server.test.ts tests/integration/server.test.ts
```

Expected: PASS.

### Task 4: Make the HTTP bridge discover or spawn the project server

**Files:**

- Modify: `src/bin/http-bridge.ts:1-202`
- Create: `src/server/project-connector.ts`
- Test: `tests/unit/server/project-connector.test.ts`
- Modify: `tests/unit/bin/http-bridge.test.ts:1-335`
- Modify: `tests/integration/http-bridge.test.ts:1-204`

**Interfaces:**

- Produces `ensureProjectEndpoint(options): Promise<URL>`.
- `ProjectConnectorOptions` contains project root, storage directory, child
  executable path, inherited environment, `spawn`, `fetch`, and timeout values.
- `runHttpBridge()` continues to accept a resolved URL and remains transport-only.
- Produces `runBridgeCli(argv, env, dependencies)`, an exported CLI helper whose
  injected dependencies are `ensureProjectEndpoint` and `runHttpBridge`.

- [ ] **Step 1: Write failing connector tests**

```ts
it('reuses a healthy endpoint without spawning a child', async () => {
  await writeProjectEndpoint(storageDir, healthyEndpoint);

  const url = await ensureProjectEndpoint(harness);

  expect(url.href).toBe(healthyEndpoint.url);
  expect(harness.spawn).not.toHaveBeenCalled();
});

it('spawns once when two connectors race without an endpoint', async () => {
  const [first, second] = await Promise.all([
    ensureProjectEndpoint(firstHarness),
    ensureProjectEndpoint(secondHarness),
  ]);

  expect(first.href).toBe(second.href);
  expect(spawn).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 2: Run connector tests to verify they fail**

Run:

```bash
npx vitest run tests/unit/server/project-connector.test.ts
```

Expected: FAIL because `ensureProjectEndpoint` does not exist.

- [ ] **Step 3: Implement endpoint reuse and serialized detached spawn**

Resolve the project config with `loadConfig({ projectRoot })`. A descriptor is
healthy only when its URL parses, its PID is alive, and `GET /health` returns
the same instance ID and project root. Remove only a descriptor that fails this
full validation.

When no healthy descriptor exists, acquire the hash-derived global startup lock.
The winner spawns the current Nexus executable detached:

```ts
spawn(process.execPath, [
  process.argv[1],
  '--project-root',
  projectRoot,
  '--port',
  '0',
  '--managed',
], { detached: true, env: process.env, stdio: 'ignore' }).unref();
```

Both winner and waiters poll for a validated descriptor within a bounded timeout.
Always release the startup lock in `finally`.

- [ ] **Step 4: Extend Bridge CLI parsing and preserve manual overrides**

Add `--project-root` to `parseBridgeArgs`. Extract `runBridgeCli()` so it
accepts injectable dependencies and `main()` remains a thin production wrapper.
Use `--url` or `NEXUS_BRIDGE_URL` exactly as today. Without either override,
call `ensureProjectEndpoint()` and pass its URL to `runHttpBridge()`.

```ts
export async function runBridgeCli(
  argv: string[],
  env: NodeJS.ProcessEnv,
  dependencies: BridgeCliDependencies,
): Promise<void> {
  const parsed = parseBridgeArgs(argv, env);
  const url = parsed.url === undefined
    ? await dependencies.ensureProjectEndpoint({ projectRoot: parsed.projectRoot })
    : resolveBridgeUrl(parsed.url, undefined);
  await dependencies.runHttpBridge({ ...dependencies.bridgeStreams, url });
}
```

Add this regression test in the same step:

```ts
it('uses project auto-discovery only when neither URL override is supplied', async () => {
  await runBridgeCli([], {}, dependencies);

  expect(dependencies.ensureProjectEndpoint).toHaveBeenCalledOnce();
  expect(dependencies.runHttpBridge).toHaveBeenCalledOnce();
});
```

- [ ] **Step 5: Add integration coverage for a bridge-to-managed-server flow**

Use a temporary project root and the actual child CLI. Assert that two bridge
instances receive MCP responses through one endpoint descriptor, then close both
inputs and wait for descriptor removal.

- [ ] **Step 6: Run focused tests**

Run:

```bash
npx vitest run tests/unit/server/project-connector.test.ts tests/unit/bin/http-bridge.test.ts tests/integration/http-bridge.test.ts
```

Expected: PASS.

### Task 5: Document the automatic lifecycle and update OpenCode guidance

**Files:**

- Modify: `README.md`
- Modify: `docs/mcp-tools.md`
- Modify: `SPEC.md:51-63,170-179`

**Interfaces:**

- `nexus http-bridge` with no URL override is documented as automatic
  project-server discovery/startup.
- `--url` and `NEXUS_BRIDGE_URL` remain documented as external-service overrides.

- [ ] **Step 1: Update concise documentation**

Document the zero-configuration command:

```bash
nexus http-bridge
```

Explain that it manages one loopback HTTP Nexus process per project and stops it
after the final MCP client disconnects. Document manual `--url` overrides for
operators who provide their own HTTP service. Remove instructions requiring a
fixed `--port 3001` service for ordinary clients.

- [ ] **Step 2: Run documentation and targeted test checks**

Run:

```bash
npx vitest run tests/unit/bin/http-bridge.test.ts
npm run lint
```

Expected: PASS.

### Task 6: Verify the packaged CLI through its real surface

**Files:**

- No source changes.

- [ ] **Step 1: Run final verification**

Run:

```bash
npm run lint
npm test
npm run build
```

Expected: all commands exit 0.

- [ ] **Step 2: Perform manual CLI QA**

1. Start two `nexus http-bridge` processes for one temporary project.
2. Send MCP `initialize` and `tools/list` requests through both processes.
3. Confirm both receive valid JSON-RPC responses.
4. Close both stdin streams.
5. Confirm the project endpoint descriptor disappears and no Nexus child remains.
