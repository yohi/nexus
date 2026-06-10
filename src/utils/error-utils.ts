import { PathTraversalError } from "../server/path-sanitizer.js";

/**
 * Sanitizes error messages to prevent leaking internal file paths while
 * preserving useful information like connection errors or validation failures.
 */
export const sanitizeErrorMessage = (error: unknown): string => {
  if (error instanceof PathTraversalError) {
    return "Access denied: path is outside project root";
  }
  const message = error instanceof Error ? error.message : String(error);

  // Allow common network-related error messages even if they contain slashes (URLs)
  const isNetworkError =
    /fetch failed|ECONNREFUSED|ECONNRESET|ETIMEDOUT|http:\/\/|https:\/\//i.test(
      message,
    );
  if (isNetworkError) {
    return message;
  }

  // Check for absolute or relative path-like strings that might be sensitive.
  // We block things like /home/user, C:\Users, /tmp/secret, or ../../secret
  // Improved regex to avoid over-matching common URL paths like /api/ or /v1/
  const hasSensitivePath =
    /(\/(home|Users|tmp|var|etc|opt)\/|[a-zA-Z]:\\|\.\.\/)/i.test(
      message,
    );
  if (hasSensitivePath) {
    return "Internal server error (potential path leak prevented)";
  }

  return message;
};
