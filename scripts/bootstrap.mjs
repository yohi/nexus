import { execSync } from 'node:child_process';
import { existsSync, copyFileSync, unlinkSync, renameSync } from 'node:fs';

const [major] = process.versions.node.split('.').map(Number);
if (major < 22) {
  console.error(`❌ Node.js >= 22.0.0 is required (found ${process.versions.node}). Please upgrade.`);
  process.exit(1);
}

const run = (cmd) => {
  console.log(`Executing: ${cmd}`);
  try {
    execSync(cmd, { stdio: 'inherit' });
  } catch (error) {
    const details = [
      error.message,
      error.status ? `(status: ${error.status})` : '',
      error.code ? `(code: ${error.code})` : ''
    ].filter(Boolean).join(' ');
    console.error(`❌ Failed to execute: ${cmd}\n   ${details}`);
    throw error; // Propagate error for try...finally
  }
};

console.log('🚀 Nexus Bootstrap starting...');

// 1. Install dependencies
const hasToken = !!process.env.NEXUS_GH_PACKAGE_TOKEN;
const npmrc = '.npmrc';
const npmrcBak = '.npmrc.tmp_bak';
const npmrcExists = existsSync(npmrc);

if (!hasToken && npmrcExists) {
  console.log('⚠️ NEXUS_GH_PACKAGE_TOKEN not found. Temporarily bypassing .npmrc for local build...');
  try {
    renameSync(npmrc, npmrcBak);
    run('npm install');
  } catch (error) {
    console.error(`❌ Bootstrap failed during installation: ${error.message}`);
    process.exit(1);
  } finally {
    if (existsSync(npmrcBak)) {
      renameSync(npmrcBak, npmrc);
      console.log('✅ Restored .npmrc');
    }
  }
} else {
  try {
    run('npm install');
  } catch (error) {
    process.exit(1);
  }
}

// 2. Setup .env (if example exists)
if (!existsSync('.env') && existsSync('.env.example')) {
  try {
    copyFileSync('.env.example', '.env');
    console.log('✅ Created .env from .env.example');
  } catch (error) {
    console.error(`❌ Failed to copy .env.example to .env: ${error.message}`);
    process.exit(1);
  }
}

// 3. Build project
try {
  run('npm run build');
  // 4. Lint
  run('npm run lint');
} catch (error) {
  process.exit(1);
}

console.log('🎉 Bootstrap complete! Run "npm test" to verify.');
