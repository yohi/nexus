import { describe, expect, it, vi, beforeEach } from 'vitest';

const readFileMock = vi.hoisted(() => vi.fn());

vi.mock('node:fs/promises', () => ({
  readFile: readFileMock,
}));

import { loadProjectConfig, readAggregatorPortFromConfig, resolveStorageDir } from '../../src/cli.js';

describe('dashboard cli config helpers', () => {
  beforeEach(() => {
    readFileMock.mockReset();
  });

  it('loads .nexus.json once and reuses the parsed config', async () => {
    readFileMock.mockResolvedValue('{"storage":{"rootDir":"custom/.nexus"},"aggregatorPort":9555}');

    const config = await loadProjectConfig('/repo');
    const storageDir = await resolveStorageDir('/repo', config);
    const aggregatorPort = readAggregatorPortFromConfig(config);

    expect(storageDir).toBe('/repo/custom/.nexus');
    expect(aggregatorPort).toBe(9555);
    expect(readFileMock).toHaveBeenCalledTimes(1);
  });
});
