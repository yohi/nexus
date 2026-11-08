// TEST-ONLY recording language server for the Nexus LSP runtime integration tests.
//
// Launched as a real child process through the production RuntimeLocalLspManager (via a
// test-owned, Owner-approved executable wrapper in a temporary directory). It reuses the
// Task 5 stub framing, records every client message (with its pid and arrival order) to a
// JSON-lines log, tracks synchronized document text exactly as a language server would
// (didOpen / ranged or full didChange / didClose), and answers navigation requests from a
// JSON config file re-read on every request. This file is never imported by production code.
//
// Usage: node recording-language-server.mjs --stdio --config <absolute config path>
//
// Config: {
//   logPath: string,
//   initializeResult?: object,
//   exitOn?: string,                         // exit(3) right after receiving this method
//   responses?: Record<'textDocument/definition' | 'textDocument/references'
//     | 'textDocument/implementation', Array<{ uri: string, find: string, occurrence?: number }>>
// }
// A `find` spec is resolved against the server's synchronized text for `uri` when that
// document is open, otherwise against the file on disk (as a real server would analyze it).

import { appendFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { startStubLanguageServer } from './stub-language-server.mjs';

const configIndex = process.argv.indexOf('--config');
const configPath = configIndex >= 0 ? process.argv[configIndex + 1] : undefined;
if (configPath === undefined) {
  process.stderr.write('recording-language-server: missing --config\n');
  process.exit(2);
}

const readConfig = () => JSON.parse(readFileSync(configPath, 'utf8'));
const initialConfig = readConfig();
const logPath = initialConfig.logPath;

/** uri -> synchronized text */
const documents = new Map();
let sequence = 0;

const lineStarts = (text) => {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code === 13 /* \r */) {
      if (text.charCodeAt(i + 1) === 10) i += 1;
      starts.push(i + 1);
    } else if (code === 10 /* \n */) {
      starts.push(i + 1);
    }
  }
  return starts;
};

const offsetAt = (text, position) => {
  const starts = lineStarts(text);
  const start = starts[position.line];
  if (start === undefined) throw new Error('recording-language-server: line out of range');
  return start + position.character;
};

const positionAt = (text, offset) => {
  const starts = lineStarts(text);
  let line = 0;
  while (line + 1 < starts.length && starts[line + 1] <= offset) line += 1;
  return { line, character: offset - starts[line] };
};

const applyChange = (uri, change) => {
  const previous = documents.get(uri);
  if (previous === undefined) throw new Error('recording-language-server: change for unopened document');
  if (change.range === undefined) {
    documents.set(uri, change.text);
    return;
  }
  const start = offsetAt(previous, change.range.start);
  const end = offsetAt(previous, change.range.end);
  documents.set(uri, previous.slice(0, start) + change.text + previous.slice(end));
};

const textFor = (uri) => {
  const open = documents.get(uri);
  if (open !== undefined) return open;
  try {
    return readFileSync(fileURLToPath(uri), 'utf8');
  } catch {
    return undefined;
  }
};

const resolveSpecs = (method) => {
  const specs = readConfig().responses?.[method];
  if (!Array.isArray(specs)) return null;
  const locations = [];
  for (const spec of specs) {
    const text = textFor(spec.uri);
    if (text === undefined) continue;
    let index = -1;
    for (let n = 0; n <= (spec.occurrence ?? 0); n += 1) {
      index = text.indexOf(spec.find, index + 1);
      if (index < 0) break;
    }
    if (index < 0) continue;
    locations.push({
      uri: spec.uri,
      range: { start: positionAt(text, index), end: positionAt(text, index + spec.find.length) },
    });
  }
  return locations;
};

const record = (message) => {
  appendFileSync(logPath, `${JSON.stringify({ pid: process.pid, seq: sequence, message })}\n`);
  sequence += 1;
  switch (message.method) {
    case 'textDocument/didOpen':
      documents.set(message.params.textDocument.uri, message.params.textDocument.text);
      break;
    case 'textDocument/didChange':
      for (const change of message.params.contentChanges) applyChange(message.params.textDocument.uri, change);
      break;
    case 'textDocument/didClose':
      documents.delete(message.params.textDocument.uri);
      break;
    default:
      break;
  }
  if (initialConfig.exitOn !== undefined && message.method === initialConfig.exitOn) process.exit(3);
};

const stub = startStubLanguageServer({
  input: process.stdin,
  output: process.stdout,
  config: {
    ...(initialConfig.initializeResult === undefined ? {} : { initializeResult: initialConfig.initializeResult }),
    handlers: {
      'textDocument/definition': () => resolveSpecs('textDocument/definition'),
      'textDocument/references': () => resolveSpecs('textDocument/references'),
      'textDocument/implementation': () => resolveSpecs('textDocument/implementation'),
    },
  },
});

// Observe every message synchronously, in arrival order, before any request handler runs.
const seen = new WeakSet();
void stub.waitFor((message) => {
  if (!seen.has(message)) {
    seen.add(message);
    record(message);
  }
  return false;
});
void stub.waitFor((message) => message.method === 'exit').then(() => process.exit(0));
