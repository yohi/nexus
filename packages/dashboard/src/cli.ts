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

const port = parseInt((values.port as string) ?? "9464", 10);
const interval = parseInt((values.interval as string) ?? "2000", 10);

const { waitUntilExit } = render(React.createElement(App, { port, interval }));
await waitUntilExit();
