/**
 * Normalizes ignore patterns by:
 * 1. Converting Windows backslashes to forward slashes.
 * 2. Trimming leading ./ and trailing /.
 * 3. Expanding each pattern into both file and directory glob forms.
 */
export const normalizeIgnorePaths = (ignorePaths: string[]): string[] =>
  ignorePaths.flatMap((p) => {
    const normalized = p.replaceAll("\\", "/").replace(/^\.\/+|\/+$/g, "");
    return [`**/${normalized}`, `**/${normalized}/**`];
  });
