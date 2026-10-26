import { mkdtemp, mkdir, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { generateFixture } from '../../../benchmarks/performance/fixtures.js';
import { createFixturePathNormalizer } from '../../../benchmarks/performance/logical-path.js';

const directories: string[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'nexus-logical-path-'));
  directories.push(root);
  const manifest = await generateFixture(root, 'smoke');
  const file = manifest.files[0];
  if (file === undefined) throw new Error('file required');
  return { root, manifest, file };
}
afterEach(async () => { await Promise.all(directories.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe('fixture response-path normalization', () => {
  it('accepts native in-root absolute and manifest logical paths without collapsing duplicates', async () => {
    const current = await fixture();
    const normalize = await createFixturePathNormalizer(current.root, current.manifest);
    expect(await normalize(join(current.root, current.file.path))).toBe(current.file.path);
    expect(await normalize(current.file.path)).toBe(current.file.path);
    expect(await Promise.all([current.file.path, join(current.root, current.file.path)].map(normalize)))
      .toEqual([current.file.path, current.file.path]);
  });

  it.each(['', '../escape.ts', './source.ts', 'a/../source.ts', 'a//source.ts', 'a\0b.ts',
    'C:source.ts', 'C:\\foreign\\source.ts', '\\\\server\\share\\source.ts', 'a\\b.ts'])(
    'rejects invalid relative identity %j without echoing it in diagnostics', async (value) => {
      const current = await fixture();
      const normalize = await createFixturePathNormalizer(current.root, current.manifest);
      const failure = await normalize(value).then(() => undefined, (error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      if (failure instanceof Error && value !== '') expect(failure.message).not.toContain(value);
      expect(JSON.stringify(failure)).not.toContain(current.root);
    },
  );

  it('rejects sibling-prefix and outside-root absolute paths using real containment', async () => {
    const current = await fixture();
    const normalize = await createFixturePathNormalizer(current.root, current.manifest);
    await expect(normalize(join(dirname(current.root), `${basename(current.root)}-sibling`, current.file.path))).rejects.toThrow();
    await expect(normalize(join(dirname(current.root), 'outside.ts'))).rejects.toThrow();
  });

  it('rejects unknown files and a manifest file deleted after preflight', async () => {
    const current = await fixture();
    const normalize = await createFixturePathNormalizer(current.root, current.manifest);
    await writeFile(join(current.root, 'unknown.ts'), 'export function unknown() {}\n');
    await expect(normalize('unknown.ts')).rejects.toThrow();
    await unlink(join(current.root, current.file.path));
    await expect(normalize(current.file.path)).rejects.toThrow();
  });

  it('rejects a symlink escape installed after preflight', async () => {
    const current = await fixture();
    const other = await fixture();
    const normalize = await createFixturePathNormalizer(current.root, current.manifest);
    const path = join(current.root, current.file.path);
    await unlink(path);
    await symlink(join(other.root, other.file.path), path, 'file');
    await expect(normalize(current.file.path)).rejects.toThrow();
  });

  it('rejects internal symlink aliases rather than merging manifest identities', async () => {
    const current = await fixture();
    const normalize = await createFixturePathNormalizer(current.root, current.manifest);
    const second = current.manifest.files[1];
    if (second === undefined) throw new Error('second file required');
    const path = join(current.root, current.file.path);
    await unlink(path);
    await symlink(join(current.root, second.path), path, 'file');
    await expect(normalize(current.file.path)).rejects.toThrow();
  });

  it('preserves manifest case and CJK spelling without Unicode or case normalization', async () => {
    const current = await fixture();
    const logical = 'packages/Case/日本語.ts';
    await mkdir(dirname(join(current.root, logical)), { recursive: true });
    await writeFile(join(current.root, logical), await readFile(join(current.root, current.file.path)));
    const manifest = { ...current.manifest, files: [{ ...current.file, path: logical }, ...current.manifest.files.slice(1)] };
    const normalize = await createFixturePathNormalizer(current.root, manifest);
    expect(await normalize(join(current.root, logical))).toBe(logical);
    await expect(normalize('packages/case/日本語.ts')).rejects.toThrow();
  });

  it('rejects symlinked manifest files already present during preflight', async () => {
    const current = await fixture();
    const second = current.manifest.files[1];
    if (second === undefined) throw new Error('second file required');
    const path = join(current.root, current.file.path);
    await unlink(path); await symlink(join(current.root, second.path), path, 'file');
    await expect(createFixturePathNormalizer(current.root, current.manifest)).rejects.toThrow();
  });

  it('rejects a directory replacing a preflight manifest file', async () => {
    const current = await fixture();
    const normalize = await createFixturePathNormalizer(current.root, current.manifest);
    const path = join(current.root, current.file.path);
    await unlink(path); await mkdir(path);
    await expect(normalize(current.file.path)).rejects.toThrow();
  });

  it('rejects duplicate manifest identities instead of overwriting their mappings', async () => {
    const current = await fixture();
    await expect(createFixturePathNormalizer(current.root,
      { ...current.manifest, files: [...current.manifest.files, current.file] })).rejects.toThrow();
  });

  it.runIf(process.platform === 'win32')('accepts native Windows absolute separators only after containment', async () => {
    const current = await fixture();
    const normalize = await createFixturePathNormalizer(current.root, current.manifest);
    expect(await normalize(join(current.root, current.file.path))).toBe(current.file.path);
  });
});
