#!/usr/bin/env node
import { handleFatalError } from "./fatal-error.js";

try {
  const { main } = (await import(new URL("../dashboard/cli.js", import.meta.url).href)) as {
    readonly main: (args: string[]) => Promise<void>;
  };
  await main(process.argv.slice(2));
} catch (error) {
  handleFatalError("Failed to start dashboard", error);
}
