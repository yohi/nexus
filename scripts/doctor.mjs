import { readFile, writeFile } from 'node:fs/promises';
import { execSync } from 'node:child_process';
import path from 'node:path';

const projectRoot = process.cwd();
const configPath = path.join(projectRoot, '.nexus.json');

async function checkInotifyLimits() {
  if (process.platform !== 'linux') {
    console.log('ℹ️  Skipping inotify check (non-linux system)');
    return true;
  }

  try {
    const limit = parseInt(execSync('cat /proc/sys/fs/inotify/max_user_watches').toString().trim(), 10);
    console.log(`📊 System inotify limit: ${limit}`);

    // Rough estimate of files in the project (excluding common ignore dirs)
    const fileCount = parseInt(
      execSync('find . -maxdepth 3 -not -path "*/.*" | wc -l').toString().trim(),
      10
    );
    
    if (limit < 65536) {
      console.warn('⚠️  Warning: System inotify limit is low. You might encounter ENOSPC errors on larger projects.');
      console.log('👉 Recommended fix: echo fs.inotify.max_user_watches=524288 | sudo tee -a /etc/sysctl.conf && sudo sysctl -p');
    }
    return true;
  } catch (err) {
    console.warn('⚠️  Could not check inotify limits:', err.message);
    return false;
  }
}

async function checkConfig() {
  let config = {};
  try {
    const raw = await readFile(configPath, 'utf8');
    config = JSON.parse(raw);
    console.log('✅ Found .nexus.json');
  } catch (err) {
    if (err.code === 'ENOENT') {
      console.log('ℹ️  No .nexus.json found, using defaults.');
    } else {
      console.error('❌ Failed to read .nexus.json:', err.message);
      return;
    }
  }

  const recommendedIgnores = ['.worktrees', 'node_modules', '.nexus', 'dist', 'coverage'];
  const currentIgnores = config.watcher?.ignorePaths || [];
  const missingIgnores = recommendedIgnores.filter(p => !currentIgnores.includes(p));

  if (missingIgnores.length > 0) {
    console.log(`⚠️  Missing recommended ignore paths in .nexus.json: ${missingIgnores.join(', ')}`);
    
    // Auto-fix if missing
    const newConfig = {
      ...config,
      watcher: {
        ...config.watcher,
        ignorePaths: [...new Set([...currentIgnores, ...missingIgnores])]
      }
    };

    try {
      await writeFile(configPath, JSON.stringify(newConfig, null, 2));
      console.log('🚀 Successfully updated .nexus.json with recommended ignore paths.');
    } catch (err) {
      console.error('❌ Failed to update .nexus.json:', err.message);
    }
  } else {
    console.log('✅ Configuration is healthy.');
  }
}

async function runDoctor() {
  console.log('🩺 Nexus Doctor - Diagnosing your setup...\n');
  await checkInotifyLimits();
  console.log('');
  await checkConfig();
  console.log('\n✨ Diagnostics complete.');
}

runDoctor().catch(err => {
  console.error('❌ Doctor failed:', err);
  process.exit(1);
});
