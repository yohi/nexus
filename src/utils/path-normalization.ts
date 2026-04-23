/**
 * Normalizes ignore patterns by:
 * 1. Converting Windows backslashes to forward slashes.
 * 2. Trimming leading ./ and trailing /.
 * 3. Expanding each pattern into both file and directory glob forms.
 *
 * Skip empty or invalid patterns that result in "" after normalization.
 */
export const normalizeIgnorePaths = (ignorePaths: string[]): string[] =>
  ignorePaths.flatMap((p) => {
    const normalized = p.replaceAll("\\", "/").replace(/^\.\/+|\/+$/g, "");
    if (normalized === "" || normalized.trim() === "") {
      return [];
    }
    return [normalized, `${normalized}/**`, `**/${normalized}`, `**/${normalized}/**` ];
  });
