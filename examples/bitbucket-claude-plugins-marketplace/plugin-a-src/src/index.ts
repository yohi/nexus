export function greet(name: string): string {
  return `Hello from Plugin A, ${name}!`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(greet('Claude Code'));
}
