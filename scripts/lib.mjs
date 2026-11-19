// Shared helpers for the runner, scanner pre-pass, and test scorer. Cross-platform (no shell).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const HARNESS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const IS_WIN = process.platform === 'win32';

export function loadConfig() {
  return JSON.parse(fs.readFileSync(path.join(HARNESS, 'audit.config.json'), 'utf8'));
}

// Find an executable on PATH without invoking a shell. Returns an absolute path or null.
export function findExe(name) {
  const exts = IS_WIN ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';').map(e => e.toLowerCase()) : [''];
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const ext of IS_WIN ? ['.exe', ...exts.filter(e => e !== '.exe')] : ['']) {
      const p = path.join(dir, name + ext);
      try { if (fs.statSync(p).isFile()) return p; } catch { /* keep looking */ }
    }
  }
  // winget adds tools to PATH only for shells started after the install; look in its folders too.
  if (IS_WIN && process.env.LOCALAPPDATA) {
    const wg = path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet');
    const link = path.join(wg, 'Links', `${name}.exe`);
    if (fs.existsSync(link)) return link;
    try {
      for (const pkg of fs.readdirSync(path.join(wg, 'Packages'))) {
        const p = path.join(wg, 'Packages', pkg, `${name}.exe`);
        if (fs.existsSync(p)) return p;
      }
    } catch { /* no winget packages */ }
  }
  return null;
}

// Copy source files (minus excluded dirs) to a fresh ASCII temp folder. Used for scanners that
// silently scan nothing when the path contains non-ASCII characters (semgrep on Windows).
export function stageCopy(root, excludeDirs, maxBytes = 5 * 1024 * 1024) {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-stage-'));
  walk(root, excludeDirs, (f) => {
    try {
      if (fs.statSync(f).size > maxBytes) return;
      const out = path.join(dest, path.relative(root, f));
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.copyFileSync(f, out);
    } catch { /* unreadable file: skip */ }
  });
  return dest;
}

// Windows refuses to spawn .cmd/.bat without a shell; run those through cmd.exe with quoted args.
export function runTool(exe, args, opts = {}) {
  const base = { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: opts.timeout ?? 10 * 60 * 1000, cwd: opts.cwd, env: opts.env ?? process.env, windowsHide: true };
  if (IS_WIN && /\.(cmd|bat)$/i.test(exe)) {
    const q = s => `"${String(s).replace(/"/g, '""')}"`;
    return spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${[exe, ...args].map(q).join(' ')}"`], { ...base, windowsVerbatimArguments: true });
  }
  return spawnSync(exe, args, base);
}

// Coverage ledger for the auditor: source files and lines per first-level module ("." = files in
// the root). The report must account for every module listed here (full read vs. justified sample).
export function buildInventory(root, cfg) {
  const mods = new Map();
  walk(root, cfg.excludeDirs, (f) => {
    if (!cfg.sourceExtensions.includes(path.extname(f).toLowerCase())) return;
    const rel = path.relative(root, f);
    const top = rel.includes(path.sep) ? rel.split(path.sep)[0] : '.';
    const m = mods.get(top) ?? { module: top, files: 0, lines: 0, bytes: 0 };
    try {
      const text = fs.readFileSync(f, 'utf8');
      m.lines += text.split('\n').length; m.bytes += Buffer.byteLength(text);
    } catch { /* unreadable: counted as a file with no lines */ }
    m.files++;
    mods.set(top, m);
  });
  const modules = [...mods.values()].sort((a, b) => b.lines - a.lines);
  return { totalFiles: modules.reduce((a, m) => a + m.files, 0), totalLines: modules.reduce((a, m) => a + m.lines, 0), modules };
}

// Recursively list files, skipping excluded directory names. Does not follow symlinks.
export function walk(root, excludeDirs, onFile) {
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (!excludeDirs.includes(e.name)) stack.push(full); }
      else if (e.isFile()) onFile(full);
    }
  }
}

// sha256 of every file under root except excluded dirs. Big files are fingerprinted by size+mtime.
export function snapshot(root, excludeDirs, bigFileBytes = 50 * 1024 * 1024) {
  const map = new Map();
  walk(root, excludeDirs, (f) => {
    const rel = path.relative(root, f).split(path.sep).join('/');
    try {
      const st = fs.statSync(f);
      map.set(rel, st.size > bigFileBytes
        ? `big:${st.size}:${st.mtimeMs}`
        : crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'));
    } catch (e) { map.set(rel, `unreadable:${e.code}`); }
  });
  return map;
}

export function diffSnapshots(before, after) {
  const changes = [];
  for (const [k, v] of before) {
    if (!after.has(k)) changes.push({ file: k, change: 'deleted' });
    else if (after.get(k) !== v) changes.push({ file: k, change: 'modified' });
  }
  for (const k of after.keys()) if (!before.has(k)) changes.push({ file: k, change: 'added' });
  return changes;
}

export function timestamp(d = new Date()) {
  return d.toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
}
