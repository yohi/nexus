import { execSync } from 'node:child_process';
import { existsSync, copyFileSync } from 'node:fs';

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
run('npm install');

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
