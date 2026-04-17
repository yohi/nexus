#!/usr/bin/env node
import { parseArgs } from "node:util";
import React from "react";
import { render } from "ink";
import { App } from "./app.js";

const { values } = parseArgs({
  options: {
    port: { type: "string", default: "9464" },
    interval: { type: "string", default: "2000" },
  },
  strict: false,
});

const port = (() => {
  const parsed = parseInt(values.port as string, 10);
  if (isNaN(parsed) || parsed < 1 || parsed > 65535) {
    console.warn(`Invalid --port value "${values.port}", falling back to 9464`);
    return 9464;
  }
  return parsed;
})();

const interval = (() => {
  const parsed = parseInt(values.interval as string, 10);
  if (isNaN(parsed) || parsed < 1000) {
    console.warn(`Invalid --interval value "${values.interval}", falling back to 2000 (min 1000ms)`);
    return 2000;
  }
  return parsed;
})();

const { waitUntilExit } = render(React.createElement(App, { port, interval }));
await waitUntilExit();
