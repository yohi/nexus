import { describe, expect, it, vi, beforeEach } from 'vitest';

const readFileMock = vi.hoisted(() => vi.fn());
const realpathMock = vi.hoisted(() => vi.fn(async (input: string) => input));
const statMock = vi.hoisted(() => vi.fn(async () => ({ isDirectory: () => true })));

vi.mock('node:fs/promises', () => ({
  readFile: readFileMock,
  realpath: realpathMock,
  stat: statMock,
}));

import { loadProjectConfig, readAggregatorPortFromConfig, resolveStorageDir } from '../../src/cli.js';

describe('dashboard cli config helpers', () => {
  beforeEach(() => {
    readFileMock.mockReset();
    realpathMock.mockClear();
    statMock.mockClear();
    vi.unstubAllEnvs();
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

  it('accepts Windows drive-letter storage roots from the environment', async () => {
    vi.stubEnv('NEXUS_STORAGE_ROOT_DIR', String.raw`C:\repo\.nexus`);

    const storageDir = await resolveStorageDir('/repo');

    expect(storageDir).toBe(String.raw`C:\repo\.nexus`);
  });

  it('skips loading config when the resolved project root escapes the requested directory', async () => {
    readFileMock.mockResolvedValue('{"aggregatorPort":9555}');
    realpathMock.mockResolvedValue('/resolved/repo');

    await expect(loadProjectConfig('/repo-link')).resolves.toBeUndefined();

    expect(readFileMock).not.toHaveBeenCalled();
  });
});
