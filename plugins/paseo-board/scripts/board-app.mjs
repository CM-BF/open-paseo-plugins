#!/usr/bin/env node
import { main } from '../backend/cli.mjs';
await main(process.argv.slice(2));
