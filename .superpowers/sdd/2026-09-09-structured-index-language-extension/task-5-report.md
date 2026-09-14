# Task 5 Report: C Language Plugin

## Status

DONE

## What Was Implemented

- Added the C structured parser support helpers, declaration selector, and include import extractor.
- Added `CStructuredParser` backed by `tree-sitter-c` 0.24.1.
- Added `CLanguagePlugin` with `.c` support and legacy parser projection.
- Added exactness and malformed-source fixtures and focused parser tests.
- Preserved byte ranges, source hashes, diagnostics, and degraded parsing behavior.

## Testing

- `npx vitest run tests/unit/structured/c-parser.test.ts -v`: PASS, 2 tests.
- `npx tsc --noEmit`: PASS.
- `npm run lint -- --no-warn-ignored`: PASS.
- `npx vitest run`: PASS, 125 test files and 1004 tests.

## TDD Evidence

### RED

Command:

```text
npx vitest run tests/unit/structured/c-parser.test.ts -v
```

Result: FAIL during test collection because `src/plugins/languages/c.js` did not exist.

### GREEN

Command:

```text
npx vitest run tests/unit/structured/c-parser.test.ts -v
```

Result: PASS, 2 tests.

## Files Changed

- `src/plugins/languages/c-structured-support.ts`
- `src/plugins/languages/c-structured-declarations.ts`
- `src/plugins/languages/c-structured-imports.ts`
- `src/plugins/languages/c-structured.ts`
- `src/plugins/languages/c.ts`
- `tests/fixtures/structured/c/exactness.c`
- `tests/fixtures/structured/c/partial.c`
- `tests/unit/structured/c-parser.test.ts`
- `.superpowers/sdd/2026-09-09-structured-index-language-extension/task-5-report.md`

## Self-Review Findings

- The implementation follows the task brief and existing structured-language plugin boundaries.
- `childForFieldName()` returns `null` at runtime in this tree-sitter API, so the recursive declarator lookup correctly checks `!== null` rather than `!== undefined`.
- No production or test concerns remain after focused and full verification.

## Issues or Concerns

- The pre-existing untracked `packages/dashboard/node_modules.bak/` was not modified or included.

## Verification

- `tree-sitter-c@0.24.1` is present in `package.json`; the dependency was added in Task 1.
- `npm run lint`: PASS.
- `npm run license:check`: PASS; `License check passed for 257 production packages.`
- `npm run build`: PASS; TypeScript build and dashboard bundle completed successfully.
- `npm ci` was verified in Task 1. Task 5 introduced no dependency or lockfile changes.
- `npx tsc --noEmit`: PASS.
- `npx vitest run tests/unit/structured/c-parser.test.ts -v`: PASS, 3 tests.
- `npx vitest run`: PASS, 125 test files and 1005 tests.

## Fix Report

### Code Change

Updated `c-structured-declarations.ts` so tagged struct and enum declarations wrapped by a C `declaration` node use the enclosing `declaration` as `descriptor.node` and the tagged specifier as `descriptor.rangeNode`. This makes the existing syntax checks cover malformed declaration containers. Direct tagged specifiers remain supported for the installed `tree-sitter-c@0.24.1` AST shape.

### Regression Fixture and Test

- Added `tests/fixtures/structured/c/partial-struct.c` with valid `Good` and malformed `Bad` tagged structs.
- Added a focused test asserting degraded status, retention of `Good`, and omission of `Bad`.

### Commands and Output

```text
npx vitest run tests/unit/structured/c-parser.test.ts -v
PASS: 1 test file, 3 tests

npx tsc --noEmit
PASS

npm run lint
PASS

npm run license:check
PASS: License check passed for 257 production packages.

npm run build
PASS: TypeScript build and dashboard esbuild completed.

npx vitest run
PASS: 125 test files, 1005 tests

node --input-type=module -e "... packageJson.dependencies['tree-sitter-c'] ..."
0.24.1
```

The added regression test was already green before the code change because the installed grammar emits the malformed fixture as a direct `struct_specifier` plus an `ERROR` sibling. The code change still covers the reviewed wrapped-`declaration` AST shape while preserving the installed grammar's direct-node behavior.
