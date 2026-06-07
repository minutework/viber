#!/usr/bin/env node

import { runViberMcpCli } from "./server.js";

const exitCode = await runViberMcpCli({ args: process.argv.slice(2) });
process.exit(exitCode);
