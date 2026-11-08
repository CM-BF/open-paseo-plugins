import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(process.argv[2] || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
const names = ['backend/cli.mjs', 'backend/comments.mjs', 'backend/files.mjs', 'backend/remote.mjs', 'backend/scaffold.mjs', 'backend/server.mjs', 'backend/ssh.mjs', 'backend/storage.mjs', 'backend/visitor.mjs', 'scripts/board-app.mjs'];
const files = Object.fromEntries(await Promise.all(names.map(async name => [name, await fs.readFile(path.join(root, name), 'utf8')])));
const output = `${JSON.stringify({ version: 1, files })}\n`;
await fs.mkdir(path.join(root, 'server/assets'), { recursive: true });
await fs.writeFile(path.join(root, 'server/assets/app-runtime.txt'), output);
console.log(`Board application runtime: ${Buffer.byteLength(output)} bytes (${names.length} files)`);
