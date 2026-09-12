# Structured Index

The structured index stores **declarations** (functions, classes, interfaces,
variables, and so on) and **imports** for supported source files. It is built
alongside the vector index during `--reindex --full` and is used for
symbol-aware retrieval and reasoning.

## Supported languages and extensions

| Language family         | Structured extensions                                        |
| ----------------------- | ------------------------------------------------------------ |
| TypeScript / JavaScript | `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`, `.mts`, `.cts` |
| Python                  | `.py`, `.pyi`                                                |
| Go                      | `.go`                                                        |
| Rust                    | `.rs`                                                        |
| Java                    | `.java`                                                      |
| C#                      | `.cs`                                                        |
| C                       | `.c`                                                         |
| C++                     | `.h`, `.cc`, `.cpp`, `.cxx`, `.hh`, `.hpp`, `.hxx`           |

A file with a supported extension is routed to the structured parser for that
language family. It still receives vector chunks at the same time. Structured
declarations and imports are produced only when the parser actually extracts
them from the file; not every supported file necessarily contributes
structured records.

## Structured index vs vector index

Files with supported extensions may contribute to both the structured index
and the vector index, depending on whether the structured parser extracts
declarations and imports from them.

Files with unsupported extensions (for example `.md`, `.txt`) are still
indexed, but only as fixed-line **vector chunks**. They do not produce
structured declarations or imports.

## Known limitations

- **TypeScript / JavaScript:** CommonJS `require()` calls and assignment-style
  exports such as `module.exports`, `exports.foo`, and `export = { ... }` are
  **not extracted** as structured declarations or imports in Phase 1. Only
  ECMAScript `import` and declaration syntax is captured.

- **C / C++:** Header files (`.h`) are parsed as C++. The parser performs
  source-only syntax analysis; it does not resolve compilation semantics such
  as preprocessor defines, include paths, or conditional compilation.

## Upgrading to a new language set

Files that already existed in a workspace before a new language is added and
have not changed since are not reprocessed automatically. To backfill existing
unchanged files with newly supported extensions, run `nexus --reindex --full`.

## Requesting additional languages

To request support for another language or extension, open an issue that
includes:

1. The language or extension you need.
2. A sample source file that should be parsed.
3. The declarations and imports you expect to be extracted.
