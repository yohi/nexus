import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { executeGetContext } from '../../../../src/server/tools/get-context.js';
import { PathSanitizer } from '../../../../src/server/path-sanitizer.js';
import { PathTraversalError } from '../../../../src/types/index.js';

const tempRoots: string[] = [];

const createProjectRoot = async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-get-context-'));
  tempRoots.push(root);
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(path.join(root, 'src', 'auth.ts'), 'line1\nline2\nline3\nline4');
  return root;
};

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('executeGetContext', () => {
  it('returns the requested line slice from the file content', async () => {
    const projectRoot = await createProjectRoot();
    const sanitizer = await PathSanitizer.create(projectRoot);
    const result = await executeGetContext(
      async (filePath) => fs.readFile(filePath, 'utf8'),
      sanitizer,
      {
        filePath: 'src/auth.ts',
        startLine: 2,
        endLine: 3,
      },
    );

    expect(result).toEqual({
      filePath: 'src/auth.ts',
      content: 'line2\nline3',
      startLine: 2,
      endLine: 3,
    });
  });

  it('rejects path traversal before reading file content', async () => {
    const sanitizer = await PathSanitizer.create(process.cwd());

    await expect(
      executeGetContext(
        async () => {
          throw new Error('loadFileContent should not be called');
        },
        sanitizer,
        { filePath: '../../../etc/passwd' },
      ),
    ).rejects.toBeInstanceOf(PathTraversalError);
  });
});
