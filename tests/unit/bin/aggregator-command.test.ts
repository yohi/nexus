import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";

import {
  type AggregatorCliDependencies,
  parseAggregatorArgs,
  resolveAggregatorPort,
  runAggregatorCli,
} from "../../../src/bin/aggregator-command.js";

function collectOutput(): { readonly stream: PassThrough; readonly text: () => string } {
  const stream = new PassThrough();
  const chunks: Buffer[] = [];
  stream.on("data", (chunk: Buffer) => chunks.push(chunk));
  return { stream, text: () => Buffer.concat(chunks).toString("utf8") };
}

describe("aggregator command", () => {
  it("parses help without reading global process arguments", () => {
    const parsed = parseAggregatorArgs(["--help"], {});

    expect(parsed.help).toBe(true);
    expect(parsed.port).toBeUndefined();
  });

  it("prints command-specific help without loading config or starting a server", async () => {
    const output = collectOutput();
    const dependencies: AggregatorCliDependencies = {
      createAggregator: vi.fn(),
      errorOutput: new PassThrough(),
      loadConfig: vi.fn(),
      output: output.stream,
      signalSource: process,
    };

    await runAggregatorCli(["--help"], {}, dependencies);

    expect(output.text()).toContain("Nexus Metrics Aggregator");
    expect(output.text()).toContain("--port <number>");
    expect(dependencies.loadConfig).not.toHaveBeenCalled();
    expect(dependencies.createAggregator).not.toHaveBeenCalled();
  });

  it("resolves the port in CLI, config, environment, default precedence order", () => {
    expect(resolveAggregatorPort("9501", 9502, "9503")).toBe(9501);
    expect(resolveAggregatorPort(undefined, 9502, "9503")).toBe(9502);
    expect(resolveAggregatorPort(undefined, undefined, "9503")).toBe(9503);
    expect(resolveAggregatorPort(undefined, undefined, undefined)).toBe(9470);
  });

  it.each([
    ["invalid CLI syntax", "abc", undefined, undefined, "Invalid port value: abc"],
    ["out-of-range CLI port", "65536", undefined, undefined, "Invalid port: 65536"],
    [
      "invalid environment syntax",
      undefined,
      undefined,
      "abc",
      "Invalid NEXUS_AGGREGATOR_PORT environment variable: abc",
    ],
    ["out-of-range config port", undefined, 0, undefined, "Invalid port: 0"],
  ])("rejects %s", (_name, cliPort, configPort, envPort, message) => {
    expect(() => resolveAggregatorPort(cliPort, configPort, envPort)).toThrow(message);
  });
});
