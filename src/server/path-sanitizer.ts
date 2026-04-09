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
   * (1) Resolves the candidate via path.resolve(this.projectRoot, filePath) and
   *     verifies with path.relative to ensure the resolved path stays inside projectRoot.
   * (2) Uses fs.realpath to resolve symlinks and verify the real path also remains
   *     under projectRoot via another path.relative check.
   * If realpath fails with ENOENT, it propagates the error so callers can distinguish missing files.
   */
  async sanitize(filePath: string): Promise<string> {
    const resolvedPath = path.resolve(this.projectRoot, filePath);

    const relativePath = path.relative(this.projectRoot, resolvedPath);
    if (
      relativePath === '..' ||
      relativePath.startsWith('..' + path.sep) ||
      path.isAbsolute(relativePath)
    ) {
      throw new PathTraversalError(`Access denied: path '${filePath}' is outside project root`);
    }

    try {
      const realPath = await fs.realpath(resolvedPath);
      const relativeRealPath = path.relative(this.projectRoot, realPath);
      if (
        relativeRealPath === '..' ||
        relativeRealPath.startsWith('..' + path.sep) ||
        path.isAbsolute(relativeRealPath)
      ) {
        throw new PathTraversalError(
          `Access denied: symlink resolved to '${realPath}' outside project root`,
        );
      }
      return realPath;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        // Propagate ENOENT so callers can distinguish missing files from security violations
        throw error;
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

  /**
   * Validates and normalizes a glob pattern.
   * Rejects patterns containing directory traversal (..) by tokenizing on all possible path separators and brace expansion characters.
   * Normalizes backslashes to forward slashes for cross-platform compatibility.
   */
  validateGlob(pattern: string): string {
    const normalized = pattern.replace(/\\/g, '/');

    // Tokenize on path separators, braces, and commas to prevent bypasses like "{src,../secret}"
    const tokens = normalized.split(/[/{},]+/);

    if (tokens.includes('..')) {
      throw new PathTraversalError(`Glob pattern '${pattern}' contains directory traversal`);
    }

    return normalized;
  }
}
