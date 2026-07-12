import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  PROJECT_ENDPOINT_FILENAME,
  readProjectEndpoint,
  removeProjectEndpoint,
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
});
