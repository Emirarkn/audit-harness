#!/usr/bin/env node
// PreToolUse hook for AUDIT RUNS. Spec: permissions/POLICY.md (keep the two in sync).
//
// Hook contract: exit 0 = no objection (settings rules still apply);
//                exit 2 = block, reason on stderr (shown to Claude).
// Fail-closed: missing config, unparsable input, or any internal error blocks the call.
//
// Env (set by scripts/audit.mjs):
//   AUDIT_TARGET        absolute path of the audited project
//   AUDIT_HARNESS       absolute path of this harness (default: parent of permissions/)
//   AUDIT_RUN_DIR       this run's folder; guard.log is appended there
//   AUDIT_GIT_DISABLED  "1" when the target's git config looked dangerous

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------- patterns

export const SECRET_PATTERNS = [
  [/AKIA[0-9A-Z]{16}/, 'AWS access key'],
  [/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/, 'API secret key (sk-…)'],
  [/\b(?:sk|rk)_live_[0-9A-Za-z]{16,}/, 'Stripe live key'],
  [/\bghp_[A-Za-z0-9]{36}\b|\bgithub_pat_[A-Za-z0-9_]{30,}/, 'GitHub token'],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/, 'Slack token'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/, 'Google API key'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'private key'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, 'JWT'],
];

export const PII_PATTERNS = [
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/, 'email address'],
  [/\b[1-9]\d{10}\b/, '11-digit number (possible T.C. kimlik no)'],
  [/(?:\+90|\b0)\s?5\d{2}[\s-]?\d{3}[\s-]?\d{2}[\s-]?\d{2}\b/, 'Turkish phone number'],
];

const META_TOOLS = new Set(['TodoWrite', 'ToolSearch']);

const GIT_READ_SUBCOMMANDS = new Set([
  'log', 'show', 'diff', 'status', 'ls-files', 'ls-tree', 'blame', 'rev-parse',
  'rev-list', 'shortlog', 'cat-file', 'grep', 'describe',
]);
const GIT_FORBIDDEN_ARGS = [/^--output/, /^--ext-diff$/, /^--textconv$/, /^--filters$/, /^-O/, /^--open-files-in-pager/];

const PATH_READ_CMDS = new Set(['ls', 'cat', 'head', 'tail', 'wc', 'stat', 'file', 'du', 'tree', 'realpath', 'basename', 'dirname']);
const FIND_FORBIDDEN = new Set(['-exec', '-execdir', '-ok', '-okdir', '-delete', '-fprint', '-fprint0', '-fprintf', '-fls']);
const GREP_OPTS_WITH_ARG = new Set(['-e', '-f', '-m', '-A', '-B', '-C', '-d', '-D', '--regexp', '--file', '--max-count', '--context', '--after-context', '--before-context']);

// ---------------------------------------------------------------- paths

function pathApi(ctx) { return ctx.win ? path.win32 : path.posix; }

// Resolve to a canonical absolute path. Follows symlinks/junctions of the nearest existing
// ancestor so a link inside the target cannot point the guard somewhere else.
export function resolvePath(p, ctx, base = ctx.cwd) {
  const P = pathApi(ctx);
  let s = String(p).trim();
  if (s === '~' || s.startsWith('~/') || s.startsWith('~\\')) s = P.join(ctx.home, s.slice(1));
  if (ctx.win) {
    const m = s.match(/^\/([a-zA-Z])(?:\/|$)(.*)$/); // Git Bash style /c/Users/...
    if (m) s = `${m[1]}:/${m[2]}`;
  }
  const abs = P.resolve(base, s);
  let existing = abs;
  const rest = [];
  while (true) {
    try {
      const real = fs.realpathSync.native(existing);
      return rest.length ? P.join(real, ...rest.reverse()) : real;
    } catch {
      const parent = P.dirname(existing);
      if (parent === existing) return abs;
      rest.push(P.basename(existing));
      existing = parent;
    }
  }
}

export function isInside(child, root, ctx) {
  const P = pathApi(ctx);
  const c = ctx.win ? child.toLowerCase() : child;
  const r = ctx.win ? root.toLowerCase() : root;
  const rel = P.relative(r, c);
  return rel === '' || (!rel.startsWith('..') && !P.isAbsolute(rel));
}

function inRoots(abs, ctx) { return ctx.roots.some(r => isInside(abs, r, ctx)); }

function checkReadPath(p, ctx, label = 'path') {
  if (p === undefined || p === null || p === '') return null;
  const abs = resolvePath(p, ctx);
  if (!inRoots(abs, ctx)) return `${label} "${p}" is outside the audit roots (AUDIT_TARGET and the harness)`;
  return null;
}

// ---------------------------------------------------------------- bash

// Minimal shell tokenizer. Splits on | || && ; and newlines; rejects expansion, redirection,
// subshells, grouping, and backgrounding outside single quotes.
export function tokenize(cmd) {
  const segs = [[]];
  let cur = null;
  let q = null;
  const push = () => { if (cur !== null) { segs[segs.length - 1].push(cur); cur = null; } };
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (q === "'") { if (c === "'") q = null; else cur += c; continue; }
    if (q === '"') {
      if (c === '"') { q = null; continue; }
      if (c === '$' || c === '`') return { error: 'shell expansion ($ or `) is not allowed' };
      // bash semantics: inside "…" a backslash only escapes $ ` " \ and newline; otherwise it stays.
      if (c === '\\' && i + 1 < cmd.length && '$`"\\\n'.includes(cmd[i + 1])) { cur += cmd[++i]; continue; }
      cur += c;
      continue;
    }
    if (c === "'" || c === '"') { q = c; if (cur === null) cur = ''; continue; }
    if (c === '\\') { if (cur === null) cur = ''; cur += cmd[++i] ?? ''; continue; }
    if (c === '\n' || c === ';') { push(); segs.push([]); continue; }
    if (/\s/.test(c)) { push(); continue; }
    if (c === '|') { push(); segs.push([]); if (cmd[i + 1] === '|') i++; continue; }
    if (c === '&') {
      if (cmd[i + 1] === '&') { push(); segs.push([]); i++; continue; }
      return { error: 'background "&" is not allowed' };
    }
    if (c === '$' || c === '`') return { error: 'shell expansion ($ or `) is not allowed' };
    if ('<>(){}'.includes(c)) return { error: `shell operator "${c}" is not allowed (no redirection, subshells, or grouping)` };
    if (cur === null) cur = '';
    cur += c;
  }
  if (q) return { error: 'unbalanced quotes' };
  push();
  return { segments: segs.filter(s => s.length) };
}

// Redirections that only discard output are harmless; strip them before analysis.
function stripNullRedirects(cmd) {
  return cmd
    .replace(/(^|\s)(?:[12&]?>>?)\s*\/dev\/null(?=\s|$|[;|&])/g, '$1')
    .replace(/(^|\s)2>&1(?=\s|$|[;|&])/g, '$1');
}

function positionals(args) { return args.filter(a => !a.startsWith('-')); }

function checkGit(args, ctx) {
  if (ctx.gitDisabled) return 'git is disabled for this run: the target\'s git config defines command hooks (fsmonitor/pager/textconv/…)';
  let i = 0;
  while (i < args.length && args[i].startsWith('-')) {
    if (args[i] === '-C') {
      const err = checkReadPath(args[i + 1], ctx, 'git -C path');
      if (err) return err;
      i += 2;
    } else if (args[i] === '--no-pager') {
      i += 1;
    } else {
      return `git option "${args[i]}" is not allowed before the subcommand`;
    }
  }
  const sub = args[i];
  if (!GIT_READ_SUBCOMMANDS.has(sub)) return `git subcommand "${sub ?? '(none)'}" is not on the read-only allowlist`;
  for (const a of args.slice(i + 1)) {
    if (GIT_FORBIDDEN_ARGS.some(re => re.test(a))) return `git argument "${a}" is not allowed (it can write files or run external programs)`;
    if (looksLikeOutsidePath(a)) {
      const err = checkReadPath(a, ctx, 'git path');
      if (err) return err;
    }
  }
  return null;
}

function looksLikeOutsidePath(t) {
  return /^(~|\/|\\|[A-Za-z]:)/.test(t) || t.split(/[\\/]/).includes('..');
}

function checkGrep(args, ctx) {
  let patternGiven = false;
  const pos = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-f' || a === '--file') { const e = checkReadPath(args[i + 1], ctx, 'grep -f file'); if (e) return e; i++; continue; }
    if (a.startsWith('--file=')) { const e = checkReadPath(a.slice(7), ctx, 'grep --file'); if (e) return e; continue; }
    if (a === '-e' || a === '--regexp' || a.startsWith('--regexp=')) { patternGiven = true; if (!a.includes('=')) i++; continue; }
    if (GREP_OPTS_WITH_ARG.has(a)) { i++; continue; }
    if (a.startsWith('-')) continue;
    pos.push(a);
  }
  const paths = patternGiven ? pos : pos.slice(1);
  for (const p of paths) { const e = checkReadPath(p, ctx); if (e) return e; }
  return null;
}

function checkFind(args, ctx) {
  for (const a of args) if (FIND_FORBIDDEN.has(a)) return `find action "${a}" is not allowed`;
  const starts = [];
  for (const a of args) { if (a.startsWith('-') || a === '!' ) break; starts.push(a); }
  for (const p of starts) { const e = checkReadPath(p, ctx); if (e) return e; }
  return null;
}

function checkSegment(tokens, ctx) {
  const [cmd, ...args] = tokens;
  if (/[\\/]/.test(cmd)) return `call commands by bare name ("${cmd}" contains a path)`;
  if (cmd.includes('=')) return 'inline environment assignments are not allowed';
  switch (cmd) {
    case 'cd': {
      if (args.length !== 1) return 'cd needs exactly one directory argument';
      const abs = resolvePath(args[0], ctx);
      if (!inRoots(abs, ctx)) return `cd target "${args[0]}" is outside the audit roots`;
      ctx.cwd = abs;
      return null;
    }
    case 'git': return checkGit(args, ctx);
    case 'grep': case 'egrep': case 'fgrep': return checkGrep(args, ctx);
    case 'find': return checkFind(args, ctx);
    case 'sort':
      if (args.some(a => a === '-o' || a.startsWith('--output'))) return 'sort -o writes files; not allowed';
      break;
    case 'uniq':
      if (positionals(args).length > 1) return 'uniq with an output file is not allowed';
      break;
    case 'tree':
      if (args.includes('-o')) return 'tree -o writes files; not allowed';
      break;
    case 'echo': case 'pwd': case 'tr':
      return null; // operands are text or character sets, never files
    case 'cut':
      break;
    default:
      if (!PATH_READ_CMDS.has(cmd)) return `command "${cmd}" is not on the read-only allowlist`;
  }
  for (const p of positionals(args)) { const e = checkReadPath(p, ctx); if (e) return e; }
  return null;
}

export function checkBash(command, ctx) {
  if (typeof command !== 'string' || !command.trim()) return 'empty command';
  if (!inRoots(ctx.cwd, ctx)) return 'shell working directory is outside the audit roots; cd into AUDIT_TARGET first';
  const t = tokenize(stripNullRedirects(command));
  if (t.error) return t.error;
  const local = { ...ctx };
  for (const seg of t.segments) {
    const err = checkSegment(seg, local);
    if (err) return err;
  }
  return null;
}

// ---------------------------------------------------------------- web

function findPattern(text, patterns) {
  for (const [re, label] of patterns) if (re.test(text)) return label;
  return null;
}

export function checkWebSearch(query) {
  if (typeof query !== 'string' || !query.trim()) return 'empty query';
  if (query.length > 200) return 'query longer than 200 characters (looks like pasted content)';
  if (/[{};<>`]/.test(query)) return 'query contains code-like characters; search only public terms';
  if (/\S{60,}/.test(query)) return 'query contains a very long token (possible secret or code)';
  const s = findPattern(query, SECRET_PATTERNS); if (s) return `query contains a ${s}`;
  const p = findPattern(query, PII_PATTERNS); if (p) return `query contains personal data (${p})`;
  return null;
}

export function checkWebFetch(url) {
  let u;
  try { u = new URL(url); } catch { return 'invalid URL'; }
  if (!['https:', 'http:'].includes(u.protocol)) return `URL scheme ${u.protocol} is not allowed`;
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal') || h === '::1' || h === '0.0.0.0'
      || /^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h)
      || /^172\.(1[6-9]|2\d|3[01])\./.test(h) || /^f[cd][0-9a-f]{2}:/.test(h)) {
    return 'private/local network addresses are not allowed';
  }
  if (url.length > 500) return 'URL longer than 500 characters';
  const s = findPattern(url, SECRET_PATTERNS); if (s) return `URL contains a ${s}`;
  const p = findPattern(decodeURIComponent(u.search + u.hash), PII_PATTERNS); if (p) return `URL contains personal data (${p})`;
  return null;
}

// ---------------------------------------------------------------- decision

export function makeContext(env, input = {}, platform = process.platform) {
  const win = platform === 'win32';
  const P = win ? path.win32 : path.posix;
  if (!env.AUDIT_TARGET) throw new Error('AUDIT_TARGET is not set; the guard only runs inside audit runs');
  const harness = env.AUDIT_HARNESS || P.resolve(P.dirname(fileURLToPath(import.meta.url)), '..');
  const base = { win, home: env.HOME || env.USERPROFILE || os.homedir(), cwd: harness };
  const target = resolvePath(env.AUDIT_TARGET, base);
  const harnessReal = resolvePath(harness, base);
  const ctx = {
    ...base,
    target,
    harness: harnessReal,
    roots: [target, harnessReal],
    gitDisabled: env.AUDIT_GIT_DISABLED === '1',
  };
  ctx.cwd = input.cwd ? resolvePath(input.cwd, ctx) : harnessReal;
  return ctx;
}

export function decide(input, env, platform = process.platform) {
  const ctx = makeContext(env, input, platform);
  const tool = input.tool_name;
  const ti = input.tool_input || {};
  const P = pathApi(ctx);

  if (META_TOOLS.has(tool)) return null;
  switch (tool) {
    case 'Read':
      if (!ti.file_path) return 'Read without file_path';
      return checkReadPath(ti.file_path, ctx, 'file');
    case 'Glob': {
      const e = checkReadPath(ti.path || ctx.cwd, ctx, 'glob path');
      if (e) return e;
      const pat = String(ti.pattern || '');
      if (looksLikeOutsidePath(pat)) {
        const prefix = pat.split(/[*?[{]/)[0] || '.';
        return checkReadPath(prefix, ctx, 'glob pattern');
      }
      return null;
    }
    case 'Grep':
      return checkReadPath(ti.path || ctx.cwd, ctx, 'grep path');
    case 'Write': {
      if (!ti.file_path) return 'Write without file_path';
      const want = P.join(ctx.target, 'AUDIT_REPORT.md');
      const got = resolvePath(ti.file_path, ctx);
      const same = ctx.win ? got.toLowerCase() === want.toLowerCase() : got === want;
      if (!same) return `writes are only allowed to ${want}`;
      const s = findPattern(String(ti.content ?? ''), SECRET_PATTERNS);
      if (s) return `report contains an unredacted ${s}; redact it (type + location + first 4 chars) and retry`;
      return null;
    }
    case 'Bash':
      return checkBash(ti.command, ctx);
    case 'WebSearch':
      return checkWebSearch(ti.query);
    case 'WebFetch':
      return checkWebFetch(String(ti.url || ''));
    default:
      return `tool "${tool}" is not permitted in audit runs`;
  }
}

// ---------------------------------------------------------------- main

function log(env, entry) {
  try {
    if (!env.AUDIT_RUN_DIR) return;
    fs.appendFileSync(path.join(env.AUDIT_RUN_DIR, 'guard.log'), JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
  } catch { /* logging must never change the decision */ }
}

function summarize(input) {
  const ti = input.tool_input || {};
  const s = ti.command ?? ti.file_path ?? ti.path ?? ti.query ?? ti.url ?? ti.pattern ?? '';
  return String(s).slice(0, 300);
}

async function main() {
  const env = process.env;
  let input = {};
  try {
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const reason = decide(input, env);
    log(env, { tool: input.tool_name, decision: reason ? 'deny' : 'allow', reason, input: summarize(input) });
    if (reason) {
      process.stderr.write(`[audit guard] BLOCKED: ${reason}. See permissions/POLICY.md.\n`);
      process.exit(2);
    }
    process.exit(0);
  } catch (err) {
    log(env, { tool: input.tool_name, decision: 'deny', reason: `guard error: ${err.message}` });
    process.stderr.write(`[audit guard] BLOCKED (fail-closed): ${err.message}\n`);
    process.exit(2);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
