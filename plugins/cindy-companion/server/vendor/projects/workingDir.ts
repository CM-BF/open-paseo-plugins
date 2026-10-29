export function normalizeWorkingDirForStorage(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const path = String(raw);
  if (path.trim() === '') return null;

  const withoutLongPathPrefix = stripWindowsLongPathPrefix(path);
  const outNeedsWindowsSeparatorRewrite =
    isWindowsPathLike(path) || isWindowsPathLike(withoutLongPathPrefix);
  let out = outNeedsWindowsSeparatorRewrite
    ? withoutLongPathPrefix.replace(/\\/g, '/')
    : withoutLongPathPrefix;
  while (out.length > 1 && out.endsWith('/')) {
    if (/^[A-Za-z]:\/$/.test(out)) break;
    out = out.slice(0, -1);
  }
  return out;
}

export function stripWindowsLongPathPrefix(p: string): string {
  if (p.startsWith('\\\\?\\UNC\\')) return `\\\\${p.slice('\\\\?\\UNC\\'.length)}`;
  if (p.startsWith('\\\\?\\')) return p.slice('\\\\?\\'.length);
  return p;
}

/** 盘符路径或 UNC(`\\server` / `//server`)——按 Windows 规则归一的判据。 */
export function isWindowsPathLike(p: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\') || p.startsWith('//');
}
