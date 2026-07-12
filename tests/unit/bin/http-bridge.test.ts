import { PassThrough, Readable } from "node:stream";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_BRIDGE_URL,
  type HttpBridgeOptions,
  parseBridgeArgs,
  resolveBridgeUrl,
  runHttpBridge,
} from "../../../src/bin/http-bridge.js";

class FakeTransport implements Transport {
  readonly sent: JSONRPCMessage[] = [];
  startCalls = 0;
  closeCalls = 0;
  callbacksInstalledAtStart = false;
  protocolVersion: string | undefined;
  startError: Error | undefined;
  sendError: Error | undefined;
  closeError: Error | undefined;
  onStart: (() => void) | undefined;
  onSend: ((message: JSONRPCMessage) => void) | undefined;
  onmessage: Transport["onmessage"];
  onerror: Transport["onerror"];
  onclose: Transport["onclose"];

  async start(): Promise<void> {
    this.startCalls += 1;
    this.callbacksInstalledAtStart =
      this.onmessage !== undefined && this.onerror !== undefined && this.onclose !== undefined;
    this.onStart?.();

    if (this.startError !== undefined) {
      throw this.startError;
    }
  }

  async send(message: JSONRPCMessage): Promise<void> {
    this.sent.push(message);

    if (this.sendError !== undefined) {
      throw this.sendError;
    }

    this.onSend?.(message);
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
    this.onclose?.();

    if (this.closeError !== undefined) {
      throw this.closeError;
    }
  }

  emitMessage(message: JSONRPCMessage): void {
    this.onmessage?.(message);
  }

  emitError(error: Error): void {
    this.onerror?.(error);
  }

  setProtocolVersion(version: string): void {
    this.protocolVersion = version;
  }
}

function createRequest(id: string | number, method: string): JSONRPCMessage {
  return { id, jsonrpc: "2.0", method };
}

function createResult(id: string | number, result: Record<string, unknown>): JSONRPCMessage {
  return { id, jsonrpc: "2.0", result };
}

function collectOutput(): { readonly stream: PassThrough; readonly text: () => string } {
  const stream = new PassThrough();
  const chunks: string[] = [];
  stream.on("data", (chunk: Buffer) => {
    chunks.push(chunk.toString("utf8"));
  });

  return { stream, text: () => chunks.join("") };
}

function createBridgeHarness(input: Readable, transport: FakeTransport) {
  const output = collectOutput();
  const errorOutput = collectOutput();
  const options: HttpBridgeOptions = {
    url: new URL(DEFAULT_BRIDGE_URL),
    input,
    output: output.stream,
    errorOutput: errorOutput.stream,
    createTransport: () => transport,
  };

  return { errorOutput, options, output };
}

describe("http bridge", () => {
  describe("resolveBridgeUrl", () => {
    it("prefers the CLI URL over the environment URL", () => {
      const url = resolveBridgeUrl(
        "http://127.0.0.1:4100/mcp",
        "http://127.0.0.1:4200/mcp",
      );

      expect(url.href).toBe("http://127.0.0.1:4100/mcp");
    });

    it("uses the environment URL when no CLI URL is supplied", () => {
      const url = resolveBridgeUrl(undefined, "http://127.0.0.1:4200/mcp");

      expect(url.href).toBe("http://127.0.0.1:4200/mcp");
    });

    it("uses the loopback default when no override is supplied", () => {
      const url = resolveBridgeUrl(undefined, undefined);

      expect(DEFAULT_BRIDGE_URL).toBe("http://127.0.0.1:3001");
      expect(url.href).toBe("http://127.0.0.1:3001/");
    });

    it("rejects an invalid bridge URL", () => {
      expect(() => resolveBridgeUrl("not a URL", undefined)).toThrow(
        /Invalid bridge URL/,
      );
    });
  });

  describe("runHttpBridge", () => {
    it("installs every transport callback before starting", async () => {
      const transport = new FakeTransport();
      const harness = createBridgeHarness(Readable.from([]), transport);

      await runHttpBridge(harness.options);

      expect(transport.callbacksInstalledAtStart).toBe(true);
    });

    it("forwards two messages in order and writes their responses", async () => {
      const first = createRequest(1, "ping");
      const second = createRequest(2, "tools/list");
      const transport = new FakeTransport();
      transport.onSend = (message) => {
        if ("id" in message && "method" in message) {
          transport.emitMessage(createResult(message.id, { method: message.method }));
        }
      };
      const harness = createBridgeHarness(
        Readable.from([`${JSON.stringify(first)}\n`, `${JSON.stringify(second)}\n`]),
        transport,
      );

      await runHttpBridge(harness.options);

      expect(transport.sent).toEqual([first, second]);
      expect(harness.output.text()).toBe(
        `${JSON.stringify(createResult(1, { method: "ping" }))}\n` +
          `${JSON.stringify(createResult(2, { method: "tools/list" }))}\n`,
      );
    });

    it("ignores blank input lines", async () => {
      const request = createRequest(1, "ping");
      const transport = new FakeTransport();
      const harness = createBridgeHarness(
        Readable.from(["\n", "  \n", `${JSON.stringify(request)}\n`, "\t\n"]),
        transport,
      );

      await runHttpBridge(harness.options);

      expect(transport.sent).toEqual([request]);
      expect(harness.output.text()).toBe("");
      expect(harness.errorOutput.text()).toBe("");
    });

    it("reports malformed input on stderr and continues with the next valid line", async () => {
      const request = createRequest(1, "ping");
      const transport = new FakeTransport();
      const harness = createBridgeHarness(
        Readable.from([
          "not valid JSON\n",
          `${JSON.stringify({ jsonrpc: "2.0", method: 42 })}\n`,
          `${JSON.stringify(request)}\n`,
        ]),
        transport,
      );

      await runHttpBridge(harness.options);

      expect(transport.sent).toEqual([request]);
      expect(harness.output.text()).toBe("");
      expect(harness.errorOutput.text()).toContain("Invalid JSON input");
      expect(harness.errorOutput.text()).toContain("Invalid JSON-RPC input");
    });

    it("sets the negotiated protocol version from the initialize response", async () => {
      const request = createRequest("initialize-1", "initialize");
      const transport = new FakeTransport();
      transport.onSend = (message) => {
        if ("id" in message && "method" in message) {
          transport.emitMessage(
            createResult(message.id, { protocolVersion: "2025-03-26" }),
          );
        }
      };
      const harness = createBridgeHarness(Readable.from([`${JSON.stringify(request)}\n`]), transport);

      await runHttpBridge(harness.options);

      expect(transport.protocolVersion).toBe("2025-03-26");
    });

    it("closes the transport once when input reaches EOF", async () => {
      const transport = new FakeTransport();
      const harness = createBridgeHarness(Readable.from([]), transport);

      await runHttpBridge(harness.options);

      expect(transport.closeCalls).toBe(1);
    });

    it.each(["SIGINT", "SIGTERM"] as const)(
      "closes the transport once when %s is emitted repeatedly",
      async (signal) => {
        const input = new PassThrough();
        const transport = new FakeTransport();
        transport.onStart = () => {
          process.emit(signal);
          process.emit(signal);
        };
        const harness = createBridgeHarness(input, transport);

        await runHttpBridge(harness.options);

        expect(transport.closeCalls).toBe(1);
      },
    );

    it("propagates a start failure", async () => {
      const transport = new FakeTransport();
      transport.startError = new Error("connection failed");
      const harness = createBridgeHarness(Readable.from([]), transport);

      await expect(runHttpBridge(harness.options)).rejects.toThrow("connection failed");
      expect(transport.closeCalls).toBe(1);
    });

    it("stops after a send failure and closes the transport", async () => {
      const first = createRequest(1, "ping");
      const second = createRequest(2, "tools/list");
      const transport = new FakeTransport();
      transport.sendError = new Error("request failed");
      const harness = createBridgeHarness(
        Readable.from([`${JSON.stringify(first)}\n`, `${JSON.stringify(second)}\n`]),
        transport,
      );

      await expect(runHttpBridge(harness.options)).rejects.toThrow("request failed");
      expect(transport.sent).toEqual([first]);
      expect(transport.closeCalls).toBe(1);
    });

    it("surfaces a close failure once", async () => {
      const transport = new FakeTransport();
      transport.closeError = new Error("close failed");
      const harness = createBridgeHarness(Readable.from([]), transport);

      await expect(runHttpBridge(harness.options)).rejects.toThrow("close failed");
      expect(transport.closeCalls).toBe(1);
    });

    it("writes transport errors to stderr without contaminating stdout", async () => {
      const transport = new FakeTransport();
      transport.onStart = () => {
        transport.emitError(new Error("network disconnected"));
      };
      const harness = createBridgeHarness(Readable.from([]), transport);

      await runHttpBridge(harness.options);

      expect(harness.errorOutput.text()).toContain("network disconnected");
      expect(harness.output.text()).toBe("");
    });
  });
  describe("parseBridgeArgs", () => {
    it("uses the CLI URL over the environment URL", () => {
      const result = parseBridgeArgs(
        ["--url", "http://127.0.0.1:4100/mcp"],
        { NEXUS_BRIDGE_URL: "http://127.0.0.1:4200/mcp" },
      );

      expect(result.help).toBe(false);
      expect(result.url.href).toBe("http://127.0.0.1:4100/mcp");
    });

    it("uses the environment URL when no CLI URL is supplied", () => {
      const result = parseBridgeArgs(["--help"], {
        NEXUS_BRIDGE_URL: "http://127.0.0.1:4200/mcp",
      });

      expect(result.help).toBe(true);
      expect(result.url.href).toBe("http://127.0.0.1:4200/mcp");
    });

    it("uses the default URL when neither CLI nor environment URL is supplied", () => {
      const result = parseBridgeArgs([], {});

      expect(result.help).toBe(false);
      expect(result.url.href).toBe("http://127.0.0.1:3001/");
    });

    it("rejects unknown options under strict parsing", () => {
      expect(() =>
        parseBridgeArgs(["--unknown"], { NEXUS_BRIDGE_URL: undefined }),
      ).toThrow();
    });
  });
});
