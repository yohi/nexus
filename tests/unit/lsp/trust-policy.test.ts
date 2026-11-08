import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ spawn: spawnMock, default: { spawn: spawnMock } }));

import { resolveApprovedLspLaunch } from '../../../src/lsp/trust-policy.js';
import type { LspConfig } from '../../../src/types/index.js';

const posixOnly = process.platform === 'win32' ? describe.skip : describe;

posixOnly('resolveApprovedLspLaunch', () => {
  let base: string;
  let projectRoot: string;
  let exe: string;
  let storeDir: string;
  let storePath: string;
  let env: NodeJS.ProcessEnv;

  const sha = (bytes: string) => createHash('sha256').update(bytes).digest('hex');
  const lspFor = (overrides: Partial<LspConfig['typescript']> = {}): LspConfig => ({
    enabled: true,
    typescript: { executable: exe, args: ['--stdio'], ...overrides },
    startupTimeoutMs: 10_000,
    requestTimeoutMs: 10_000,
    idleTimeoutMs: 60_000,
  });
  const approval = (overrides: Record<string, unknown> = {}) => ({
    projectRoot,
    executable: exe,
    executableSha256: sha('#!/bin/sh\nexit 0\n'),
    args: ['--stdio'],
    serverVersion: '6.0.2',
    ...overrides,
  });
  const writeStore = async (approvals: unknown[], mode = 0o600) => {
    await writeFile(storePath, JSON.stringify({ version: 1, approvals }), 'utf8');
    await chmod(storePath, mode);
  };
  const run = (lsp: LspConfig = lspFor(), extra: Record<string, unknown> = {}) =>
    resolveApprovedLspLaunch({ projectRoot, lsp, env, ...extra });

  beforeEach(async () => {
    base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'nexus-trust-')));
    projectRoot = path.join(base, 'project');
    await mkdir(projectRoot);
    exe = path.join(base, 'bin-lsp');
    await writeFile(exe, '#!/bin/sh\nexit 0\n', 'utf8');
    await chmod(exe, 0o755);
    const xdg = path.join(base, 'xdg');
    storeDir = path.join(xdg, 'nexus');
    await mkdir(storeDir, { recursive: true });
    await chmod(xdg, 0o700);
    await chmod(storeDir, 0o700);
    storePath = path.join(storeDir, 'lsp-trust.json');
    env = {
      XDG_CONFIG_HOME: xdg,
      HOME: base,
      TMPDIR: '/tmp',
      LANG: 'C',
      AWS_SECRET_ACCESS_KEY: 'x',
      AWS_ACCESS_KEY_ID: 'x',
      GH_TOKEN: 'x',
      SSH_AUTH_SOCK: '/s',
      NODE_OPTIONS: '--require evil',
      NEXUS_EMBEDDING_API_KEY: 'x',
    };
    spawnMock.mockClear();
  });
  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it('reports invalid config first', async () => {
    expect(await run(lspFor(), { configError: 'LSP_CONFIG_INVALID' })).toEqual({
      status: 'unavailable',
      reasonCode: 'LSP_CONFIG_INVALID',
    });
  });

  it('reports not configured when disabled or executable is null', async () => {
    expect(await run({ ...lspFor(), enabled: false })).toEqual({ status: 'unavailable', reasonCode: 'LSP_NOT_CONFIGURED' });
    expect(await run(lspFor({ executable: null }))).toEqual({ status: 'unavailable', reasonCode: 'LSP_NOT_CONFIGURED' });
  });

  it('approves an exact match and builds a minimal env', async () => {
    await writeStore([approval()]);
    const decision = await run();
    expect(decision.status).toBe('ok');
    if (decision.status !== 'ok') return;
    expect(decision.launch).toMatchObject({ executable: exe, args: ['--stdio'], cwd: projectRoot, serverVersion: '6.0.2' });
    const keys = Object.keys(decision.launch.env);
    for (const k of keys) expect(['HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'PATH']).toContain(k);
    expect(keys).not.toEqual(expect.arrayContaining(['AWS_SECRET_ACCESS_KEY', 'GH_TOKEN', 'SSH_AUTH_SOCK', 'NODE_OPTIONS']));
    expect(keys.some((k) => k.startsWith('NEXUS_') || k.startsWith('AWS_'))).toBe(false);
    expect(decision.launch.env.PATH).toContain(path.dirname(process.execPath));
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('requires trust when the trust file is missing', async () => {
    expect(await run()).toEqual({ status: 'unavailable', reasonCode: 'LSP_TRUST_REQUIRED' });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('requires trust when no trust directory can be derived', async () => {
    await writeStore([approval()]);
    expect(await resolveApprovedLspLaunch({ projectRoot, lsp: lspFor(), env: {} })).toEqual({
      status: 'unavailable',
      reasonCode: 'LSP_TRUST_REQUIRED',
    });
  });

  it('rejects a symlinked trust directory', async () => {
    await writeStore([approval()]);
    const real = path.join(base, 'real-xdg');
    await mkdir(path.join(real, 'nexus'), { recursive: true });
    await writeFile(path.join(real, 'nexus', 'lsp-trust.json'), JSON.stringify({ version: 1, approvals: [approval()] }), 'utf8');
    await chmod(path.join(real, 'nexus', 'lsp-trust.json'), 0o600);
    await chmod(real, 0o700);
    await chmod(path.join(real, 'nexus'), 0o700);
    const link = path.join(base, 'link-xdg');
    await symlink(real, link);
    expect(await resolveApprovedLspLaunch({ projectRoot, lsp: lspFor(), env: { ...env, XDG_CONFIG_HOME: link } })).toEqual({
      status: 'unavailable',
      reasonCode: 'LSP_TRUST_REQUIRED',
    });
  });

  it('rejects a symlinked trust file', async () => {
    const real = path.join(base, 'elsewhere.json');
    await writeFile(real, JSON.stringify({ version: 1, approvals: [approval()] }), 'utf8');
    await chmod(real, 0o600);
    await symlink(real, storePath);
    expect((await run()).status).toBe('unavailable');
    expect(await run()).toMatchObject({ reasonCode: 'LSP_TRUST_REQUIRED' });
  });

  it.each([0o644, 0o640, 0o660, 0o400])('rejects trust file mode %o', async (mode) => {
    await writeStore([approval()], mode);
    expect(await run()).toEqual({ status: 'unavailable', reasonCode: 'LSP_TRUST_REQUIRED' });
  });

  it('rejects a group/world-writable trust directory', async () => {
    await writeStore([approval()]);
    await chmod(storeDir, 0o770);
    expect(await run()).toEqual({ status: 'unavailable', reasonCode: 'LSP_TRUST_REQUIRED' });
  });

  it('rejects a trust store located inside the project root', async () => {
    const inner = path.join(projectRoot, 'cfg', 'nexus');
    await mkdir(inner, { recursive: true });
    await chmod(path.join(projectRoot, 'cfg'), 0o700);
    await chmod(inner, 0o700);
    await writeFile(path.join(inner, 'lsp-trust.json'), JSON.stringify({ version: 1, approvals: [approval()] }), 'utf8');
    await chmod(path.join(inner, 'lsp-trust.json'), 0o600);
    expect(
      await resolveApprovedLspLaunch({ projectRoot, lsp: lspFor(), env: { ...env, XDG_CONFIG_HOME: path.join(projectRoot, 'cfg') } }),
    ).toEqual({ status: 'unavailable', reasonCode: 'LSP_TRUST_REQUIRED' });
  });

  it('rejects a trust store inside the project root when its first path segment starts with two dots', async () => {
    const inner = path.join(projectRoot, '..config', 'nexus');
    await mkdir(inner, { recursive: true });
    await chmod(path.join(projectRoot, '..config'), 0o700);
    await chmod(inner, 0o700);
    const innerStore = path.join(inner, 'lsp-trust.json');
    await writeFile(innerStore, JSON.stringify({ version: 1, approvals: [approval()] }), 'utf8');
    await chmod(innerStore, 0o600);

    expect(
      await resolveApprovedLspLaunch({ projectRoot, lsp: lspFor(), env: { ...env, XDG_CONFIG_HOME: path.join(projectRoot, '..config') } }),
    ).toEqual({ status: 'unavailable', reasonCode: 'LSP_TRUST_REQUIRED' });
  });

  it.each(['{not json', JSON.stringify({ version: 2, approvals: [] }), JSON.stringify({ version: 1 })])(
    'rejects invalid trust data %s',
    async (content) => {
      await writeFile(storePath, content, 'utf8');
      await chmod(storePath, 0o600);
      expect(await run()).toEqual({ status: 'unavailable', reasonCode: 'LSP_TRUST_REQUIRED' });
    },
  );

  it('requires trust for an untrusted sibling projectRoot', async () => {
    const sibling = path.join(base, 'sibling');
    await mkdir(sibling);
    await writeStore([approval()]);
    expect(await resolveApprovedLspLaunch({ projectRoot: sibling, lsp: lspFor(), env })).toEqual({
      status: 'unavailable',
      reasonCode: 'LSP_TRUST_REQUIRED',
    });
  });

  it('canonicalizes the project root before matching', async () => {
    const alias = path.join(base, 'alias');
    await symlink(projectRoot, alias);
    await writeStore([approval()]);
    const decision = await resolveApprovedLspLaunch({ projectRoot: alias, lsp: lspFor(), env });
    expect(decision.status).toBe('ok');
    if (decision.status === 'ok') expect(decision.launch.cwd).toBe(projectRoot);
  });

  it('rejects a changed executable digest', async () => {
    await writeStore([approval()]);
    await writeFile(exe, '#!/bin/sh\nexit 1\n', 'utf8');
    expect(await run()).toEqual({ status: 'unavailable', reasonCode: 'LSP_EXECUTABLE_NOT_APPROVED' });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('rejects argv mismatch', async () => {
    await writeStore([approval()]);
    expect(await run(lspFor({ args: ['--stdio', '--extra'] }))).toEqual({
      status: 'unavailable',
      reasonCode: 'LSP_EXECUTABLE_NOT_APPROVED',
    });
    expect(await run(lspFor({ args: [] }))).toMatchObject({ reasonCode: 'LSP_EXECUTABLE_NOT_APPROVED' });
  });

  it('rejects relative, missing, non-regular and non-executable executables', async () => {
    await writeStore([approval()]);
    expect(await run(lspFor({ executable: 'bin-lsp' }))).toMatchObject({ reasonCode: 'LSP_EXECUTABLE_NOT_APPROVED' });
    expect(await run(lspFor({ executable: path.join(base, 'nope') }))).toMatchObject({ reasonCode: 'LSP_EXECUTABLE_NOT_APPROVED' });
    expect(await run(lspFor({ executable: base }))).toMatchObject({ reasonCode: 'LSP_EXECUTABLE_NOT_APPROVED' });
    await chmod(exe, 0o644);
    expect(await run()).toMatchObject({ reasonCode: 'LSP_EXECUTABLE_NOT_APPROVED' });
  });

  it('matches approval by canonical executable path (symlink resolves to approved target)', async () => {
    const link = path.join(base, 'lsp-link');
    await symlink(exe, link);
    await writeStore([approval()]);
    const decision = await run(lspFor({ executable: link }));
    expect(decision.status).toBe('ok');
    if (decision.status === 'ok') expect(decision.launch.executable).toBe(exe);
  });

  it('rejects a different approved executable path', async () => {
    await writeStore([approval({ executable: path.join(base, 'other') })]);
    expect(await run()).toMatchObject({ reasonCode: 'LSP_EXECUTABLE_NOT_APPROVED' });
  });

  it.each([undefined, '6.0.1', '7.0.0', 602])('rejects missing/mismatched approved version %s', async (serverVersion) => {
    await writeStore([approval({ serverVersion })]);
    expect(await run()).toEqual({ status: 'unavailable', reasonCode: 'LSP_EXECUTABLE_NOT_APPROVED' });
    expect(spawnMock).not.toHaveBeenCalled();
  });
});
