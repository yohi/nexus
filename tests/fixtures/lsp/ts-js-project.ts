// TEST-ONLY fixture sources for the Nexus LSP navigation integration tests.
//
// Kept as string data (written into temporary worktrees at test time) so the fixture
// project is never type-checked, linted or indexed as part of this repository.

/** Small multi-file TS/JS project covering all eight supported LSP document extensions. */
export const TS_JS_PROJECT_FILES: Readonly<Record<string, string>> = Object.freeze({
  'shapes.ts': [
    'export interface Shape {',
    '  area(): number;',
    '}',
    '',
    'export function makeSquare(size: number): Shape {',
    '  return new Square(size);',
    '}',
    '',
    'export class Square implements Shape {',
    '  constructor(private readonly size: number) {}',
    '  area(): number {',
    '    return this.size * this.size;',
    '  }',
    '}',
    '',
  ].join('\n'),
  'main.ts': [
    "import { makeSquare } from './shapes.js';",
    '',
    'export const total = makeSquare(2).area();',
    '',
  ].join('\n'),
  'module.mts': 'export const fromMts = 1;\n',
  'common.cts': 'export const fromCts = 2;\n',
  'view.tsx': 'export const View = (): number => 3;\n',
  'util.js': ['export function helper() {', '  return 4;', '}', ''].join('\n'),
  'esm.mjs': ["import { helper } from './util.js';", '', 'export const fromMjs = helper();', ''].join('\n'),
  'legacy.cjs': 'module.exports = { fromCjs: 5 };\n',
  'widget.jsx': 'export const Widget = () => 6;\n',
  'tsconfig.json': `${JSON.stringify(
    {
      compilerOptions: {
        allowJs: true,
        checkJs: false,
        jsx: 'preserve',
        module: 'nodenext',
        moduleResolution: 'nodenext',
        target: 'es2022',
        strict: true,
        noEmit: true,
      },
      include: ['**/*'],
    },
    null,
    2,
  )}\n`,
});

/** Expected `textDocument/didOpen` languageId for each supported extension. */
export const EXPECTED_LANGUAGE_IDS: Readonly<Record<string, string>> = Object.freeze({
  'shapes.ts': 'typescript',
  'module.mts': 'typescript',
  'common.cts': 'typescript',
  'view.tsx': 'typescriptreact',
  'util.js': 'javascript',
  'esm.mjs': 'javascript',
  'legacy.cjs': 'javascript',
  'widget.jsx': 'javascriptreact',
});

/**
 * JS-only inferred project with a dependency declaration: with Automatic Type Acquisition
 * enabled, tsserver would try to fetch `@types/*` for it into the HOME typings cache.
 */
export const ATA_PROBE_PROJECT_FILES: Readonly<Record<string, string>> = Object.freeze({
  'package.json': `${JSON.stringify(
    { name: 'nexus-ata-probe', private: true, type: 'module', dependencies: { lodash: '4.17.21' } },
    null,
    2,
  )}\n`,
  'index.js': ["import _ from 'lodash';", '', 'export const probe = _.identity(1);', ''].join('\n'),
});
