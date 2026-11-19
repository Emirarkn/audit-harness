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
  return checkSecretName(p, ctx, label, abs);
}

// ---------------------------------------------------------------- secret-file mode
// Opt-in (AUDIT_NO_SECRET_FILES=1, runner flag --no-secret-files): files that normally hold live
// credentials are not readable, so their contents never reach the model. Best effort: names are
// matched, not contents. Hard-coded secrets in source files are still read (gitleaks, which
// redacts, covers them). See permissions/POLICY.md "Secret-file mode".
const SECRET_SAFE_ENV = /\.(example|sample|template|dist|defaults?)$/i;
export function isSecretFileName(name) {
  const n = String(name || '');
  if (/^\.env(\..+)?$/i.test(n)) return !SECRET_SAFE_ENV.test(n);
  return /\.(pem|key|p12|pfx|jks|keystore)$/i.test(n)
    || /^id_(rsa|dsa|ecdsa|ed25519)$/i.test(n)
    || /^(\.npmrc|\.pypirc|\.netrc|\.git-credentials|credentials(\.json)?)$/i.test(n);
}

const GIT_META_FLAGS = [
  /^--(oneline|stat|shortstat|numstat|name-only|name-status|graph|decorate|no-decorate|all|no-merges|merges|follow|abbrev-commit|date-order|topo-order|reverse|stat=\d+(,\d+)*)$/,
  /^-n\d*$/, /^-\d+$/, /^--max-count=\d+$/, /^--(since|until|after|before|author|committer|grep)=[^;&|`$<>]*$/,
  /^--(format|pretty)=[^`$]*$/, /^--no-pager$/,
];

// Small glob -> RegExp (*, **, ?, {a,b}); enough to ask "would this glob select a credentials file?".
function globToRegex(glob) {
  let re = '', brace = 0;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') { if (glob[i + 1] === '*') { re += '.*'; i++; if (glob[i + 1] === '/') i++; } else re += '[^/]*'; }
    else if (c === '?') re += '[^/]';
    else if (c === '{') { re += '(?:'; brace++; }
    else if (c === '}' && brace) { re += ')'; brace--; }
    else if (c === ',' && brace) re += '|';
    else re += c.replace(/[.+^$()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, 'i');
}
const CREDENTIAL_SAMPLES = ['.env', '.env.local', '.env.production', 'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519', 'server.pem', 'tls.key', 'cert.p12', 'cert.pfx', 'store.jks', 'app.keystore', '.npmrc', '.pypirc', '.netrc', '.git-credentials', 'credentials', 'credentials.json'];
export function globSelectsSecretFiles(glob) {
  if (/[\[\]!]/.test(String(glob))) return true; // character classes/negation: fail closed
  let re;
  try { re = globToRegex(String(glob).trim().replace(/^\.?\//, '')); } catch { return true; } // unparsable: fail closed
  // ripgrep matches slash-less globs against the file name at any depth
  return CREDENTIAL_SAMPLES.some(n => re.test(n) || re.test(`a/b/${n}`));
}

// Every name the file system could resolve this argument to. Windows ignores trailing dots and
// spaces (`.env.`, `.env `), treats `name:stream` / `name::$DATA` as the same file, and has 8.3
// short names (`ENV~1`); git takes `rev:path`. All of those spellings are tested.
function nameCandidates(p) {
  const out = new Set();
  const last = String(p).split(/[\\/]/).pop();
  for (const n of [last, last.split(':')[0], String(p).split(':').pop().split(/[\\/]/).pop()]) {
    out.add(n);
    out.add(n.replace(/[. ]+$/, ''));
  }
  return [...out].filter(Boolean);
}

function checkSecretName(p, ctx, label = 'path', resolved = null) {
  if (!ctx.noSecretFiles) return null;
  const names = nameCandidates(p);
  // a symlink/junction to a credentials file is judged by its target's name too
  if (resolved) names.push(...nameCandidates(resolved));
  for (const last of names) {
    // The shell (and git pathspecs) expand wildcards after the guard has looked at the name:
    // `cat .en?` is `cat .env`. A wildcard that could select a credentials file is refused.
    if (/[*?[{]/.test(last) && globSelectsSecretFiles(last)) return `${label} "${p}" uses a wildcard that could expand to a credentials file; name the files explicitly (secret-file mode)`;
    if (isSecretFileName(last)) return `${label} "${p}" is a credentials file; secret-file mode (--no-secret-files) keeps its contents out of the model's context`;
  }
  // 8.3 short names (ENV~1) are opaque aliases on Windows; refuse them for file paths (git refs like HEAD~2 are not file names)
  if (ctx.win && label !== 'git argument' && /~\d/.test(String(p).split(/[\\/]/).pop())) return `${label} "${p}" looks like a Windows 8.3 short name, which can alias a credentials file (secret-file mode)`;
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
  if (ctx.noSecretFiles) {
    const rest = args.slice(i + 1);
    if (sub === 'grep' || sub === 'cat-file') return `git ${sub} can print credentials files from any revision; not allowed in secret-file mode`;
    // log/show/diff print file contents through many flags (-p, -U, --cc, -c, -m, --raw, -S, -G, …),
    // so in this mode only a short allowlist of metadata-only flags is accepted.
    if (/^(log|show|diff)$/.test(sub)) {
      const bad = rest.find(a => a.startsWith('-') && a !== '--' && !GIT_META_FLAGS.some(re => re.test(a)));
      if (bad) return `git ${sub} flag "${bad}" is not on the metadata-only allowlist (it can print file contents); not allowed in secret-file mode`;
    }
    // A bare object id can be a blob: `git show <blob-sha>` prints it whatever its file name was.
    // Only ref names (HEAD, HEAD~2, branch, tag) are accepted; use `git log` to browse commits.
    if (sub === 'show' || sub === 'diff') {
      const hex = rest.find(a => !a.startsWith('-') && /^[0-9a-f]{7,40}$/i.test(a.split(/[~^@:]/)[0]));
      if (hex) return `git ${sub} of a raw object id could print a credentials blob; use a ref name (secret-file mode)`;
      const colon = rest.find(a => !a.startsWith('-') && a.includes(':'));
      if (colon) return `git ${sub} "${colon}" addresses a file inside a revision; not allowed in secret-file mode`;
    }
    if ((sub === 'show' || sub === 'diff') && !rest.some(a => /^--(stat|shortstat|numstat|name-only|name-status)$/.test(a))) return `git ${sub} prints patches by default; add --stat or --name-only in secret-file mode`;
  }
  for (const a of args.slice(i + 1)) {
    const sErr = checkSecretName(a, ctx, 'git argument'); if (sErr) return sErr;
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
  if (ctx.noSecretFiles && args.some(a => a === '--recursive' || a === '--dereference-recursive' || /^-[A-Za-z]*[rR][A-Za-z]*$/.test(a))) {
    return 'recursive grep would read credentials files; name the files explicitly or use the Grep tool with a glob (secret-file mode)';
  }
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
  if (ctx.noSecretFiles) {
    // Option values can name a file in forms the positional checks never see: --file=.env,
    // --exclude-from=.env, --files0-from=.env, -f.env (value glued to a short option).
    for (const a of args) {
      if (!a.startsWith('-') || a === '--') continue;
      const values = [a.includes('=') ? a.slice(a.indexOf('=') + 1) : null, /^-[A-Za-z]/.test(a) && !a.startsWith('--') ? a.slice(2) : null];
      for (const v of values.filter(Boolean)) {
        const e = checkSecretName(v, ctx, `option value in "${a}"`); if (e) return e;
      }
    }
  }
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
    noSecretFiles: env.AUDIT_NO_SECRET_FILES === '1',
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
    case 'Grep': {
      const e = checkReadPath(ti.path || ctx.cwd, ctx, 'grep path');
      if (e) return e;
      // Any output mode over a whole tree is a leak: content prints credentials lines, and
      // files_with_matches/count answer "does this pattern match?", which is an oracle that can
      // extract a secret one character at a time. Require a file-type restriction that excludes them.
      if (ctx.noSecretFiles) {
        if (!ti.glob && !ti.type) return 'Grep needs a glob or type in secret-file mode (otherwise it can search credentials files)';
        if (ti.glob && globSelectsSecretFiles(ti.glob)) return `grep glob "${ti.glob}" would select credentials files (secret-file mode)`;
      }
      return null;
    }
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
