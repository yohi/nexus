import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as nexus from '../../src/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('Distribution and Public API', () => {
  it('should export core components from the main entry point', () => {
    expect(nexus.createNexusServer).toBeDefined();
    expect(nexus.loadConfig).toBeDefined();
    expect(nexus.PluginRegistry).toBeDefined();
  });

  it('should have a valid exports map in package.json', async () => {
    const pkgPath = path.resolve(__dirname, '../../package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));

    const exports = pkg.exports;
    expect(exports).toBeDefined();
    expect(exports['.']).toBeDefined();
    expect(exports['./transport']).toBeDefined();

    // Verify ./transport maps to the correct internal path
    // pkg.exports['./transport'].import is './dist/server/transport.js'
    // This should correspond to 'src/server/transport.ts'
    const transportExport = exports['./transport'].import;
    expect(typeof transportExport).toBe('string');
    
    const expectedSrcPath = (transportExport as string)
      .replace('./dist/', 'src/')
      .replace('.js', '.ts');
    
    expect(fs.existsSync(path.resolve(__dirname, '../../', expectedSrcPath))).toBe(true);
  });
});
