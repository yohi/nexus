#!/usr/bin/env node
const { main } = (await import(new URL("../dashboard/cli.js", import.meta.url).href)) as {
  readonly main: (args: string[]) => Promise<void>;
};
await main(process.argv.slice(2));
