import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { PathSanitizer } from '../../../src/server/path-sanitizer.js';
import { PathTraversalError } from '../../../src/types/index.js';

const tempRoots: string[] = [];

const createProjectRoot = async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-path-sanitizer-'));
  tempRoots.push(root);
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(path.join(root, 'src', 'auth.ts'), 'export const auth = true;\n');
  return root;
};

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map(async (root) => {
      await fs.rm(root, { recursive: true, force: true });
    }),
  );
});

describe('PathSanitizer', () => {
  it('resolves a valid path to an absolute canonical path', async () => {
    const projectRoot = await createProjectRoot();
    const sanitizer = await PathSanitizer.create(projectRoot);

    await expect(sanitizer.resolve('src/auth.ts')).resolves.toBe(path.join(projectRoot, 'src', 'auth.ts'));
  });

  it('returns a project-relative path for valid files', async () => {
    const projectRoot = await createProjectRoot();
    const sanitizer = await PathSanitizer.create(projectRoot);

    await expect(sanitizer.resolveRelative('src/auth.ts')).resolves.toBe(path.join('src', 'auth.ts'));
  });

  it('rejects directory traversal attempts', async () => {
    const projectRoot = await createProjectRoot();
    const sanitizer = await PathSanitizer.create(projectRoot);

    await expect(sanitizer.resolve('../../../etc/passwd')).rejects.toBeInstanceOf(PathTraversalError);
  });

  it('rejects symlinks that escape the project root', async () => {
    const projectRoot = await createProjectRoot();
    const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-path-sanitizer-outside-'));
    tempRoots.push(outsideRoot);
    const outsideFile = path.join(outsideRoot, 'secret.txt');
    await fs.writeFile(outsideFile, 'secret\n');
    await fs.symlink(outsideFile, path.join(projectRoot, 'src', 'secret-link.txt'));

    const sanitizer = await PathSanitizer.create(projectRoot);

    await expect(sanitizer.resolve('src/secret-link.txt')).rejects.toBeInstanceOf(PathTraversalError);
  });

  it('rejects missing paths', async () => {
    const projectRoot = await createProjectRoot();
    const sanitizer = await PathSanitizer.create(projectRoot);

    await expect(sanitizer.resolve('src/missing.ts')).rejects.toBeInstanceOf(PathTraversalError);
  });

  it('rejects glob patterns containing parent traversal', () => {
    expect(() => PathSanitizer.validateGlob('../src/*.ts')).toThrow(PathTraversalError);
    expect(() => PathSanitizer.validateGlob('src/../*.ts')).toThrow(PathTraversalError);
  });

  it('resolves a symlinked project root during creation', async () => {
    const projectRoot = await createProjectRoot();
    const symlinkRoot = `${projectRoot}-link`;
    tempRoots.push(symlinkRoot);
    await fs.symlink(projectRoot, symlinkRoot);

    const sanitizer = await PathSanitizer.create(symlinkRoot);

    await expect(sanitizer.resolve('src/auth.ts')).resolves.toBe(path.join(projectRoot, 'src', 'auth.ts'));
  });
});
