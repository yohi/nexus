#!/usr/bin/env node
import React from "react";
import { render } from "ink";
import { App } from "./app.js";

const port = parseInt(process.env.NEXUS_METRICS_PORT ?? "9464", 10);
const interval = parseInt(process.env.NEXUS_METRICS_INTERVAL ?? "2000", 10);

const { waitUntilExit } = render(React.createElement(App, { port, interval }));
await waitUntilExit();
