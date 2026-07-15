export function handleFatalError(message: string, error: unknown): never {
  console.error(`\n❌ ${message}:`);
  console.error(error);

  console.error("\n🔍 Troubleshooting Info:");
  console.error(`   Node.js:  ${process.version}`);
  console.error(`   Platform: ${process.platform} (${process.arch})`);

  if (typeof error === "object" && error !== null) {
    const err = error as Record<string, unknown> & { code?: string; path?: string };
    const errorMessage = typeof err.message === "string" ? err.message : undefined;
    const errorStack = typeof err.stack === "string" ? err.stack : undefined;

    if (err.code === "ENOENT") {
      console.error(`   Diagnosis: A required file or directory was not found: ${err.path ?? "unknown path"}`);
      console.error("   Action:    Ensure the path is correct and accessible. Check if --project-root is set correctly.");
    } else if (err.code === "EACCES" || err.code === "EPERM") {
      console.error(`   Diagnosis: Permission denied at ${err.path ?? "unknown path"}`);
      console.error("   Action:    Check filesystem permissions for the storage and project directories.");
    } else if (errorMessage?.includes("rg") || errorMessage?.includes("ripgrep")) {
      console.error("   Diagnosis: ripgrep (rg) might be missing or not in PATH.");
      console.error("   Action:    Install ripgrep: https://github.com/BurntSushi/ripgrep#installation");
    } else if (errorMessage?.includes("better-sqlite3") || errorStack?.includes("better-sqlite3")) {
      console.error("   Diagnosis: better-sqlite3 failed to load. This usually means a native module mismatch.");
      console.error("   Action:    Try 'npm rebuild better-sqlite3' or ensure you are using a supported Node.js version.");
    } else if (errorMessage?.includes("lancedb") || errorStack?.includes("lancedb")) {
      console.error("   Diagnosis: @lancedb/lancedb failed to load. Native components might be missing.");
      console.error("   Action:    Ensure your platform is supported and you have the necessary build tools.");
    }
  }

  console.error("\n   For more details, check the indexer log in your storage directory (default: .nexus/indexer.log).\n");
  process.exit(1);
}
