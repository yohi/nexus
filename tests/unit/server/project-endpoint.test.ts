import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  PROJECT_ENDPOINT_FILENAME,
  readProjectEndpoint,
  removeProjectEndpoint,
  removeProjectEndpointIfMatching,
  waitForProjectEndpoint,
  writeProjectEndpoint,
} from '../../../src/server/project-endpoint.js';

describe('project-endpoint', () => {
  let storageDir: string;

  const endpoint = {
    instanceId: 'instance-a',
    pid: 123,
    projectRoot: '/workspace/app',
    url: 'http://127.0.0.1:43123',
  };

  beforeEach(async () => {
    storageDir = await mkdtemp(join(tmpdir(), 'nexus-project-endpoint-'));
  });

  afterEach(async () => {
    await rm(storageDir, { force: true, recursive: true });
  });

  it('atomically round-trips an endpoint for one storage directory', async () => {
    await writeProjectEndpoint(storageDir, endpoint);

    await expect(readProjectEndpoint(storageDir)).resolves.toEqual(endpoint);
  });

  it('waits for the endpoint written by the startup winner', async () => {
    const pending = waitForProjectEndpoint(storageDir, { timeoutMs: 500 });

    await writeProjectEndpoint(storageDir, endpoint);

    await expect(pending).resolves.toEqual(endpoint);
  });

  it('returns undefined if the timeout expires before the endpoint is written', async () => {
    const result = await waitForProjectEndpoint(storageDir, { timeoutMs: 50 });
    expect(result).toBeUndefined();
  });

  it('rejects a NaN timeout before reading an existing endpoint', async () => {
    await writeProjectEndpoint(storageDir, endpoint);

    await expect(waitForProjectEndpoint(storageDir, { timeoutMs: Number.NaN })).rejects.toBeInstanceOf(RangeError);
  });

  it('rejects an infinite timeout before reading an existing endpoint', async () => {
    await writeProjectEndpoint(storageDir, endpoint);

    await expect(waitForProjectEndpoint(storageDir, { timeoutMs: Number.POSITIVE_INFINITY })).rejects.toBeInstanceOf(RangeError);
  });

  it('rejects a negative timeout before reading an existing endpoint', async () => {
    await writeProjectEndpoint(storageDir, endpoint);

    await expect(waitForProjectEndpoint(storageDir, { timeoutMs: -1 })).rejects.toBeInstanceOf(RangeError);
  });

  it('returns undefined for absent or malformed endpoint descriptors', async () => {
    await expect(readProjectEndpoint(storageDir)).resolves.toBeUndefined();

    await writeFile(join(storageDir, PROJECT_ENDPOINT_FILENAME), '{');

    await expect(readProjectEndpoint(storageDir)).resolves.toBeUndefined();
  });

  it('removes an endpoint descriptor idempotently', async () => {
    await writeProjectEndpoint(storageDir, endpoint);

    await removeProjectEndpoint(storageDir);
    await expect(readProjectEndpoint(storageDir)).resolves.toBeUndefined();
    await expect(removeProjectEndpoint(storageDir)).resolves.toBeUndefined();
  });

  it('removes a descriptor only when it still matches the expected contents', async () => {
    await writeProjectEndpoint(storageDir, endpoint);

    await removeProjectEndpointIfMatching(storageDir, endpoint);
    await expect(readProjectEndpoint(storageDir)).resolves.toBeUndefined();
  });

  it('skips removal when the stored descriptor has changed', async () => {
    await writeProjectEndpoint(storageDir, endpoint);

    const newerEndpoint = { ...endpoint, instanceId: 'instance-b' };
    await removeProjectEndpointIfMatching(storageDir, newerEndpoint);
    await expect(readProjectEndpoint(storageDir)).resolves.toEqual(endpoint);
  });

  it('treats a missing descriptor as already removed in compare-and-delete', async () => {
    await expect(removeProjectEndpointIfMatching(storageDir, endpoint)).resolves.toBeUndefined();
  });
});
