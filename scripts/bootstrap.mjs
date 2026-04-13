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
    process.exit(1);
  }
};

console.log('🚀 Nexus Bootstrap starting...');

// 1. Install dependencies
const hasToken = !!process.env.NEXUS_GH_PACKAGE_TOKEN;
const npmrcExists = existsSync('.npmrc');

if (!hasToken && npmrcExists) {
  console.log('⚠️ NEXUS_GH_PACKAGE_TOKEN not found. Temporarily bypassing .npmrc for local build...');
  try {
    const npmrcBak = '.npmrc.tmp_bak';
    copyFileSync('.npmrc', npmrcBak);
    const { unlinkSync, renameSync } = await import('node:fs');
    unlinkSync('.npmrc');
    
    run('npm install');
    
    renameSync(npmrcBak, '.npmrc');
    console.log('✅ Restored .npmrc');
  } catch (error) {
    console.error(`❌ Failed to bypass .npmrc: ${error.message}`);
    process.exit(1);
  }
} else {
  run('npm install');
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
run('npm run build');

// 4. Lint
run('npm run lint');

console.log('🎉 Bootstrap complete! Run "npm test" to verify.');
