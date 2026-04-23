import { readFile, writeFile } from "node:fs/promises";
import { execSync } from "node:child_process";
import path from "node:path";

const projectRoot = process.cwd();
const configPath = path.join(projectRoot, ".nexus.json");

async function checkInotifyLimits() {
  if (process.platform !== "linux") {
    console.log("ℹ️  Skipping inotify check (non-linux system)");
    return true;
  }

  try {
    const rawLimit = await readFile(
      "/proc/sys/fs/inotify/max_user_watches",
      "utf8",
    );
    const limit = parseInt(rawLimit.trim(), 10);
    console.log(`📊 System inotify limit: ${limit}`);

    if (limit < 65536) {
      console.warn(
        "⚠️  Warning: System inotify limit is low. You might encounter ENOSPC errors on larger projects.",
      );
      console.log(
        "👉 Recommended fix: echo fs.inotify.max_user_watches=524288 | sudo tee -a /etc/sysctl.conf && sudo sysctl -p",
      );
    }
    return true;
  } catch (err) {
    console.warn("⚠️  Could not check inotify limits:", err.message);
    return false;
  }
}

async function checkConfig() {
  let config = {};
  try {
    const raw = await readFile(configPath, "utf8");
    config = JSON.parse(raw);
    console.log("✅ Found .nexus.json");
  } catch (err) {
    if (err.code === "ENOENT") {
      console.log("ℹ️  No .nexus.json found, using defaults.");
    } else {
      console.error("❌ Failed to read .nexus.json:", err.message);
      return;
    }
  }

  const recommendedIgnores = [
    "node_modules",
    ".git",
    ".worktrees",
    ".nexus",
    "dist",
    "build",
    "out",
    "coverage",
    ".cache",
    ".parcel-cache",
    "venv",
    ".venv",
    ".idea",
    ".vscode",
    ".DS_Store",
  ];

  let currentIgnores = config.watcher?.ignorePaths;
  if (
    !Array.isArray(currentIgnores) ||
    !currentIgnores.every((item) => typeof item === "string")
  ) {
    console.warn(
      '⚠️  "watcher.ignorePaths" is not a valid array of strings. Resetting to recommended defaults.',
    );
    currentIgnores = [];
  }

  const missingIgnores = recommendedIgnores.filter(
    (p) => !currentIgnores.includes(p),
  );

  if (missingIgnores.length > 0) {
    console.log(
      `⚠️  Missing recommended ignore paths in .nexus.json: ${missingIgnores.join(", ")}`,
    );

    // Auto-fix if missing
    const newConfig = {
      ...config,
      watcher: {
        ...config.watcher,
        ignorePaths: [...new Set([...currentIgnores, ...missingIgnores])],
      },
    };

    try {
      await writeFile(configPath, JSON.stringify(newConfig, null, 2));
      console.log(
        "🚀 Successfully updated .nexus.json with recommended ignore paths.",
      );
    } catch (err) {
      console.error("❌ Failed to update .nexus.json:", err.message);
    }
  } else {
    console.log("✅ Configuration is healthy.");
  }
}

async function runDoctor() {
  console.log("🩺 Nexus Doctor - Diagnosing your setup...\n");
  await checkInotifyLimits();
  console.log("");
  await checkConfig();
  console.log("\n✨ Diagnostics complete.");
}

runDoctor().catch((err) => {
  console.error("❌ Doctor failed:", err);
  process.exit(1);
});
