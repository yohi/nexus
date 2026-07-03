import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function greet(name: string): string {
  return `Hello from Plugin A, ${name}!`;
}

if (fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  console.log(greet('Claude Code'));
}
