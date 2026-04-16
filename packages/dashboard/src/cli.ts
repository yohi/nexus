#!/usr/bin/env node
import React from "react";
import { render } from "ink";
import { App } from "./app.js";

const rawPort = process.env.NEXUS_METRICS_PORT;
const rawInterval = process.env.NEXUS_METRICS_INTERVAL;

let port = 9464;
if (rawPort) {
  const parsed = parseInt(rawPort, 10);
  if (!isNaN(parsed) && parsed >= 1 && parsed <= 65535) {
    port = parsed;
  } else {
    console.warn(`Invalid NEXUS_METRICS_PORT "${rawPort}", falling back to 9464`);
  }
}

let interval = 2000;
if (rawInterval) {
  const parsed = parseInt(rawInterval, 10);
  if (!isNaN(parsed) && parsed >= 1000) {
    interval = parsed;
  } else {
    console.warn(`Invalid NEXUS_METRICS_INTERVAL "${rawInterval}", falling back to 2000ms (min 1000ms)`);
  }
}

const { waitUntilExit } = render(React.createElement(App, { port, interval }));
await waitUntilExit();
