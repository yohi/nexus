import path from 'node:path';
import fs from 'node:fs/promises';

export class PathTraversalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PathTraversalError';
  }
}

export class PathSanitizer {
  private constructor(private readonly projectRoot: string) {}

  /**
   * Create a PathSanitizer.
   * It resolves the projectRoot via realpath to ensure the root itself is absolute and canonical.
   */
  static async create(projectRoot: string): Promise<PathSanitizer> {
    const resolvedRoot = await fs.realpath(path.resolve(projectRoot));
    return new PathSanitizer(resolvedRoot);
  }

  /**
   * Sanitizes and validates a file path.
   * (1) Resolves the candidate via path.resolve(projectRoot, filePath) and verifies the
   *     resolved path startsWith the projectRoot.
   * (2) Uses fs.realpath to resolve symlinks and verify the real path also remains
   *     under projectRoot.
   */
  async sanitize(filePath: string): Promise<string> {
    const resolvedPath = path.resolve(this.projectRoot, filePath);

    const relativePath = path.relative(this.projectRoot, resolvedPath);
    if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
      throw new PathTraversalError(`Access denied: path '${filePath}' is outside project root`);
    }

    try {
      const realPath = await fs.realpath(resolvedPath);
      const relativeRealPath = path.relative(this.projectRoot, realPath);
      if (relativeRealPath.startsWith('..') || path.isAbsolute(relativeRealPath)) {
        throw new PathTraversalError(
          `Access denied: symlink resolved to '${realPath}' outside project root`,
        );
      }
      return realPath;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        // If the file doesn't exist yet, we still return the resolved path
        return resolvedPath;
      }
      console.error('Error during realpath resolution:', {
        error,
        originalInput: filePath,
        resolvedPath,
        projectRoot: this.projectRoot,
      });
      throw error;
    }
  }
}
