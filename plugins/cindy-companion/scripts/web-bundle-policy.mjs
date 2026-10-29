import fs from 'node:fs';
import path from 'node:path';

/** Vendored renderer files sit outside web/, so Node's ancestor lookup is unsafe. */
export function webDependencyAliases(web) {
  const pkg = JSON.parse(fs.readFileSync(path.join(web, 'package.json'), 'utf8'));
  return Object.fromEntries(Object.keys(pkg.dependencies).map(name => [name, path.join(web, 'node_modules', name)]));
}

export function assertSingleWebRuntime(meta, workingDirectory, web, required = []) {
  const roots = new Map();
  for (const input of Object.keys(meta.inputs)) {
    const absolute = path.resolve(workingDirectory, input).replaceAll('\\', '/');
    const match = /^(.*\/node_modules\/(react|react-dom|react-router|react-router-dom))\//.exec(absolute);
    if (!match) continue;
    if (!roots.has(match[2])) roots.set(match[2], new Set());
    roots.get(match[2]).add(match[1]);
  }
  for (const name of new Set([...required, ...roots.keys()])) {
    const found = roots.get(name) ?? new Set();
    const expected = path.join(web, 'node_modules', name).replaceAll('\\', '/');
    if (found.size !== 1 || !found.has(expected)) {
      throw new Error(`Settings bundle must use one web installation of ${name}; found: ${[...found].join(', ') || 'none'}`);
    }
  }
}
