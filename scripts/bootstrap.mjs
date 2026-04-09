import { execSync } from 'node:child_process';
import { existsSync, copyFileSync } from 'node:fs';

const run = (cmd) => {
  console.log(`Executing: ${cmd}`);
  try {
    execSync(cmd, { stdio: 'inherit' });
  } catch (error) {
    console.error(`❌ Failed to execute: ${cmd}`);
    process.exit(1);
  }
};

console.log('🚀 Nexus Bootstrap starting...');

// 1. Install dependencies
run('npm install');

// 2. Setup .env (if example exists)
if (!existsSync('.env') && existsSync('.env.example')) {
  copyFileSync('.env.example', '.env');
  console.log('✅ Created .env from .env.example');
}

// 3. Build project
run('npm run build');

console.log('🎉 Bootstrap complete! Run "npm test" to verify.');
