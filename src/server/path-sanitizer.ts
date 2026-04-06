import fs from 'node:fs/promises';
import path from 'node:path';

import { PathTraversalError } from '../types/index.js';

const validateWithinRoot = (projectRoot: string, candidatePath: string, attemptedPath: string): void => {
  const relativePath = path.relative(projectRoot, candidatePath);

  if (
    relativePath === '..' ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath)
  ) {
    throw new PathTraversalError(attemptedPath);
  }
};

export class PathSanitizer {
  private constructor(private readonly projectRoot: string) {}

  static async create(projectRoot: string): Promise<PathSanitizer> {
    const resolvedRoot = await fs.realpath(path.resolve(projectRoot));
    return new PathSanitizer(resolvedRoot);
  }

  async resolve(userPath: string): Promise<string> {
    const resolvedPath = path.resolve(this.projectRoot, userPath);
    validateWithinRoot(this.projectRoot, resolvedPath, userPath);

    let realPath: string;
    try {
      realPath = await fs.realpath(resolvedPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new PathTraversalError(userPath, { cause: error });
      }
      throw error;
    }

    validateWithinRoot(this.projectRoot, realPath, userPath);
    return realPath;
  }

  async resolveRelative(userPath: string): Promise<string> {
    const resolvedPath = await this.resolve(userPath);
    return path.relative(this.projectRoot, resolvedPath);
  }

  static validateGlob(pattern: string): string {
    const normalized = pattern.replace(/\\/g, '/');
    const segments = normalized.split('/');

    if (segments.includes('..')) {
      throw new PathTraversalError(pattern);
    }

    return pattern;
  }

  async sanitize(filePath: string): Promise<string> {
    return this.resolve(filePath);
  }
}
