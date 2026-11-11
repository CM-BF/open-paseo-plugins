import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { loadApp, noSymlinks, ownerFile, writeJson } from './files.mjs';

const runtimeFiles = ['cli.mjs', 'files.mjs', 'storage.mjs', 'comments.mjs', 'live.mjs', 'server.mjs', 'scaffold.mjs', 'ssh.mjs', 'remote.mjs', 'visitor.mjs'];

export async function updateRuntime(directory) {
  const app = await loadApp(directory, { createData: false });
  const source = path.dirname(fileURLToPath(import.meta.url)), target = await noSymlinks(path.join(app.root, '.board/runtime'));
  if (source === target) throw new Error('This app cannot update its own runtime; use the installed launcher: paseo-board-app update-runtime --dir <app>');
  await fs.mkdir(target, { recursive: true });
  const staged = runtimeFiles.map(name => ({ name, temporary: path.join(target, `${name}.${process.pid}.update`) }));
  try {
    for (const { name, temporary } of staged) await fs.copyFile(path.join(source, name), temporary);
    for (const { name, temporary } of staged) await fs.rename(temporary, path.join(target, name));
  } finally { for (const { temporary } of staged) await fs.rm(temporary, { force: true }); }
  return { status: 'updated', id: app.owner.id, root: app.root, files: runtimeFiles };
}

export async function initializeApp(directory, id) {
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(id || '')) throw new Error('App id must be a lowercase slug of at most 63 characters');
  const root = await noSymlinks(directory);
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  if ((await fs.readdir(root)).length) throw new Error('init requires an empty directory');
  const owner = { version: 1, id, owner: randomUUID() };
  await writeJson(path.join(root, ownerFile), owner);
  await writeJson(path.join(root, 'board-app.json'), {
    version: 1, id, entry: 'routes.mjs', dataDir: `../${path.basename(root)}-data`, host: '127.0.0.1', port: 8787,
    origins: [], public: { apiBase: '' }, comments: { enabled: false },
    deployFiles: [ownerFile, 'board-app.json', 'board-app.mjs', 'routes.mjs', 'storage.mjs', 'migrations', 'public', '.board/runtime'],
  });
  await fs.mkdir(path.join(root, '.board/runtime'), { recursive: true });
  const source = path.dirname(fileURLToPath(import.meta.url));
  for (const name of runtimeFiles) await fs.copyFile(path.join(source, name), path.join(root, '.board/runtime', name));
  await fs.mkdir(path.join(root, 'migrations')); await fs.mkdir(path.join(root, 'public'));
  await fs.copyFile(path.join(source, 'visitor.mjs'), path.join(root, 'public/board-comments.js'));
  const files = {
    'board-app.mjs': "import { main } from './.board/runtime/cli.mjs';\nawait main(process.argv.slice(2));\n",
    'routes.mjs': `// Your application logic lives here. Add any routes and use your own storage module.\nexport async function route({ request, url, storage, readJson, json }) {\n  if (url.pathname !== '/api/records') return false;\n  if (request.method === 'GET') { json(200, { records: storage.list() }); return true; }\n  if (request.method === 'POST') {\n    const value = await readJson();\n    if (typeof value.title !== 'string' || !value.title.trim() || value.title.length > 200) { json(400, { error: 'A title of 1–200 characters is required' }); return true; }\n    json(201, storage.create(value.title.trim())); return true;\n  }\n  json(405, { error: 'Use GET or POST' }); return true;\n}\n`,
    'storage.mjs': `import { randomUUID } from 'node:crypto';\n// Editable example, not a fixed data service. Replace the schema and methods freely.\nexport function createStorage(db) {\n  return {\n    list: () => db.prepare('SELECT id, title, created_at AS createdAt FROM records ORDER BY created_at').all(),\n    create(title) { const record = { id: randomUUID(), title, createdAt: new Date().toISOString() }; db.prepare('INSERT INTO records VALUES (?, ?, ?)').run(record.id, title, record.createdAt); return record; },\n  };\n}\n`,
    'migrations/001-records.sql': 'CREATE TABLE records (id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at TEXT NOT NULL) STRICT;\n',
    '.env.example': '# Server only. Never copy this file or its real values into public/.\n# Set a random 32+ character token to allow the owner-controlled Board pull.\n# BOARD_INBOX_EXPORT_TOKEN=\n# Set a different random 32+ character token to accept live public data pushed from Board; enter it only in Board\'s live-data panel, never through an agent. Setting it needs one restart.\n# BOARD_LIVE_WRITE_TOKEN=\n',
    '.gitignore': '.env\n.env.*\n!.env.example\n*.sqlite*\n*.pem\n*.key\n',
    'public/index.html': '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Board app</title><main><h1>Board app</h1><p>Your editable application starts here.</p><pre id="status">Loading…</pre></main><script type="module">const config=await fetch("./public-config.json").then(r=>r.json());const result=await fetch(`${config.apiBase}/api/records`).then(r=>r.json());document.querySelector("#status").textContent=JSON.stringify(result,null,2);</script>\n',
    'README.md': `# ${id}\n\nThis is your app source, not a fixed voting or CRUD product. Edit routes.mjs, storage.mjs, migrations/*.sql and public/.\n\nRequires Node >=22.13 (24 LTS recommended). No npm install is needed.\n\n\`node board-app.mjs migrate --dir .\`\n\`node board-app.mjs start --dir .\`\n\`node board-app.mjs backup --dir . --out ../backups/${id}.sqlite\`\n\`node board-app.mjs restore --dir . --from ../backups/${id}.sqlite --confirm <backup-sha256>\`\n\nStop the app before migration/restore. Applied migrations are immutable; append a new numbered SQL file. Both failed migrations and their history roll back together. Backups include committed WAL data and have an identity/hash sidecar. The default database directory is a private sibling of the source. Restore preserves the comment cursor high-water mark while the original data identity and database exist; a cold restore requires registering a new Board comment source. Do not delete its lock files until their recorded process has been reconciled.\n\nStart loads .env locally (server only). Only board-app.json.public is served as /public-config.json. Put no secrets in public config or source files. For Pages, copy public/ plus a separately reviewed public-config.json containing an HTTPS apiBase; set exact browser origins in board-app.json. CORS is not authentication: add application auth in routes.mjs.\n\nComments are disabled initially. Set comments.enabled=true to accept POST /_board/comments with a stable Idempotency-Key, text, optional self-reported authorName and pageUrl. Export GET /_board/comments requires a separate BOARD_INBOX_EXPORT_TOKEN (32+ characters). Register that token privately in Board; do not ship it to visitors. No comment starts an agent, grants triage, changes this app, or posts a public reply.\n\nLive public data is off until BOARD_LIVE_WRITE_TOKEN (32+ random characters) is set in the server .env (remote: shared/.env), followed by one restart. Enter that token only in Board's live-data panel and do not have an agent fill it in. Without it every /_board/live/ route returns 404. Published documents are public: GET /_board/live/<channel> needs no credential beyond an exact listed origin in browsers. Only PUT and DELETE need the token. An app created before this feature needs its runtime refreshed once with the installed launcher, \`paseo-board-app update-runtime --dir <app>\`, then a normal reviewed ssh plan and deploy; that command changes only .board/runtime.\n\nSSH deployment:\n\`node board-app.mjs ssh plan --dir . --host <ssh-config-alias> --root /absolute/private/app-root --out ../deploy-plan.json\`\nReview the exact file list and digest, then:\n\`node board-app.mjs ssh deploy --plan ../deploy-plan.json --confirm <plan-digest>\`\nUse ssh start/status/logs/stop/migrate/backup with that same plan; mutating commands require --confirm. SSH requires an already trusted host key and noninteractive login. The remote needs Node and an account you control. TLS, DNS, proxy/SSO and boot-time process supervision are your server's infrastructure; the scaffold starts a detached process but does not alter system services. Deployment never uploads .env or private data. Set remote shared/.env before enabling comment export or application credentials. Releases and shared/data are separate. A failed schema change never silently restores or downgrades data.\n`,
  };
  for (const [name, content] of Object.entries(files)) await fs.writeFile(path.join(root, name), content, { flag: 'wx', mode: name.startsWith('.env') ? 0o600 : 0o644 });
  return { root, id, dataDir: path.resolve(root, `../${path.basename(root)}-data`) };
}
