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
    throw error; // Propagate error so finally blocks can run
  }
};

const bootstrap = async () => {
  console.log('🚀 Nexus Bootstrap starting...');

  const hasToken = !!process.env.NEXUS_GH_PACKAGE_TOKEN;
  const npmrc = '.npmrc';
  const npmrcBak = '.npmrc.tmp_bak';
  const npmrcExists = existsSync(npmrc);

  try {
    // 1. Install dependencies
    if (!hasToken && npmrcExists) {
      console.log('⚠️ NEXUS_GH_PACKAGE_TOKEN not found. Temporarily bypassing .npmrc for local build...');
      try {
        renameSync(npmrc, npmrcBak);
        run('npm install');
      } finally {
        if (existsSync(npmrcBak)) {
          renameSync(npmrcBak, npmrc);
          console.log('✅ Restored .npmrc');
        }
      }
    } else {
      run('npm install');
    }

    // 2. Setup .env (if example exists)
    if (!existsSync('.env') && existsSync('.env.example')) {
      copyFileSync('.env.example', '.env');
      console.log('✅ Created .env from .env.example');
    }

    // 3. Build project
    run('npm run build');

    // 4. Lint
    run('npm run lint');

    console.log('🎉 Bootstrap complete! Run "npm test" to verify.');
  } catch (error) {
    console.error('\n❌ Bootstrap failed. Please check the errors above.');
    process.exit(1);
  }
};

bootstrap();
