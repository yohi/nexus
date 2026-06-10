import { describe, expect, it } from "vitest";
import { sanitizeErrorMessage } from "../../../src/utils/error-utils.js";

describe("error-utils", () => {
  describe("sanitizeErrorMessage", () => {
    it("preserves network error messages even if they contain sensitive-looking paths", () => {
      const urlWithTmp = "https://api.example.com/tmp/v1/data fetch failed";
      expect(sanitizeErrorMessage(new Error(urlWithTmp))).toBe(urlWithTmp);

      const urlWithHome = "Connection refused to http://localhost:8080/home/api";
      expect(sanitizeErrorMessage(new Error(urlWithHome))).toBe(urlWithHome);
    });

    it("sanitizes messages with sensitive paths that are not network errors", () => {
      expect(sanitizeErrorMessage(new Error("Failed to open /home/user/config"))).toBe(
        "Internal server error (potential path leak prevented)"
      );
      expect(sanitizeErrorMessage(new Error("Error in C:\\Users\\admin\\secret.txt"))).toBe(
        "Internal server error (potential path leak prevented)"
      );
    });

    it("sanitizes directory traversal attempts", () => {
      expect(sanitizeErrorMessage(new Error("Invalid path: ../../etc/passwd"))).toBe(
        "Internal server error (potential path leak prevented)"
      );
    });

    it("returns original message for safe errors", () => {
      expect(sanitizeErrorMessage(new Error("Invalid input: age must be a number"))).toBe(
        "Invalid input: age must be a number"
      );
    });
  });
});
