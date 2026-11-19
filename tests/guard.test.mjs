// Unit tests for permissions/guard.mjs. Free (no model calls): `node --test tests/`
// If a test fails, fix the guard, not the test, unless the test itself is wrong (CLAUDE.md B2).

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { decide } from '../permissions/guard.mjs';

const GUARD = fileURLToPath(new URL('../permissions/guard.mjs', import.meta.url));

let root, target, harness, outside, env;

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-test-'));
  target = path.join(root, 'target');
  harness = path.join(root, 'harness');
  outside = path.join(root, 'outside');
  for (const d of [target, path.join(target, 'src'), harness, path.join(harness, 'workflow'), outside]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(target, 'src', 'app.js'), 'console.log(1)\n');
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'nope\n');
  try { fs.symlinkSync(outside, path.join(target, 'escape'), 'junction'); } catch { /* symlinks unavailable */ }
  env = { AUDIT_TARGET: target, AUDIT_HARNESS: harness, HOME: os.homedir() };
});

after(() => fs.rmSync(root, { recursive: true, force: true }));

const call = (tool_name, tool_input, extraEnv = {}, cwd = target) =>
  decide({ tool_name, tool_input, cwd }, { ...env, ...extraEnv });
const allowed = (...a) => assert.equal(call(...a), null, `expected ALLOW for ${JSON.stringify(a[1])}`);
const denied = (...a) => assert.notEqual(call(...a), null, `expected DENY for ${JSON.stringify(a[1])}`);
const bash = (command, extraEnv) => call('Bash', { command }, extraEnv);

describe('read tools', () => {
  test('Read inside target', () => allowed('Read', { file_path: path.join(target, 'src', 'app.js') }));
  test('Read inside harness', () => allowed('Read', { file_path: path.join(harness, 'workflow', 'rubric.md') }));
  test('Read relative path resolves against cwd', () => allowed('Read', { file_path: 'src/app.js' }));
  test('Glob inside target', () => allowed('Glob', { pattern: '**/*.js', path: target }));
  test('Grep with no path (cwd)', () => allowed('Grep', { pattern: 'password' }));
  test('Read outside roots', () => denied('Read', { file_path: path.join(outside, 'secret.txt') }));
  test('Read ~/.ssh', () => denied('Read', { file_path: '~/.ssh/id_rsa' }));
  test('Read credentials file', () => denied('Read', { file_path: path.join(os.homedir(), '.claude', '.credentials.json') }));
  test('Read traversal out of target', () => denied('Read', { file_path: path.join(target, '..', 'outside', 'secret.txt') }));
  test('Read through symlink/junction escaping target', (t) => {
    if (!fs.existsSync(path.join(target, 'escape'))) return t.skip('symlinks unavailable');
    denied('Read', { file_path: path.join(target, 'escape', 'secret.txt') });
  });
  test('Glob with absolute pattern outside', () => denied('Glob', { pattern: `${outside.replace(/\\/g, '/')}/**` }));
  test('Grep path outside', () => denied('Grep', { pattern: 'x', path: outside }));
});

describe('write', () => {
  const report = () => path.join(target, 'AUDIT_REPORT.md');
  test('Write report with redacted secret', () => allowed('Write', { file_path: report(), content: '| SEC-001 | key `sk-a…` |' }));
  test('Write any other file in target', () => denied('Write', { file_path: path.join(target, 'src', 'app.js'), content: 'x' }));
  test('Write report into harness', () => denied('Write', { file_path: path.join(harness, 'AUDIT_REPORT.md'), content: 'x' }));
  test('Write report containing AWS key', () => denied('Write', { file_path: report(), content: 'found AKIAABCDEFGHIJKLMNOP' }));
  test('Write report containing sk- key', () => denied('Write', { file_path: report(), content: 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz' }));
  test('Write report containing private key', () => denied('Write', { file_path: report(), content: '-----BEGIN RSA PRIVATE KEY-----' }));
});

describe('forbidden tools', () => {
  for (const t of ['Edit', 'MultiEdit', 'NotebookEdit', 'PowerShell', 'Agent', 'Task', 'Skill', 'CronCreate', 'RemoteTrigger', 'mcp__claude_ai_Supabase__execute_sql']) {
    test(t, () => denied(t, {}));
  }
  test('TodoWrite allowed', () => allowed('TodoWrite', { todos: [] }));
  test('ToolSearch allowed', () => allowed('ToolSearch', { query: 'select:WebSearch' }));
});

describe('bash: allowed', () => {
  for (const c of [
    'git log --oneline -n 30',
    'git log --stat -n 10 2>/dev/null',
    "git log -p -S 'API_KEY' --all",
    'git --no-pager diff HEAD~3..HEAD',
    'git ls-files | wc -l',
    'grep -rn "password" .',
    'grep -rn "/admin" src',
    'grep -rnE "(exec|eval)\\(" src',
    'find . -name "*.js" -not -path "./node_modules/*"',
    'ls -la | head -20',
    'cat src/app.js 2>&1',
    'wc -l src/*.js',
    'head -n 5 src/app.js && tail -n 5 src/app.js',
    'cd src && ls',
    'sort src/app.js | uniq',
    "grep -o '\"CVE-[0-9-]*\"' src/app.js | sort -u | tr '\\n' ' '",
    "echo '/etc/passwd is just text here'",
  ]) test(c, () => assert.equal(bash(c), null));
  test('git -C target status', () => assert.equal(bash(`git -C "${target}" status`), null));
});

describe('bash: denied', () => {
  for (const c of [
    'rm -rf .',
    'echo x > out.txt',
    'echo x >> out.txt',
    'cat < src/app.js',
    'cat $(echo /etc/passwd)',
    'cat `echo x`',
    'echo $HOME',
    'git push origin main',
    'git commit -m x',
    'git checkout -- .',
    'git -c core.pager=sh log',
    'git diff --output=x.txt',
    'git diff --ext-diff',
    'git grep -O password',
    'find . -delete',
    'find . -name x -exec cat',
    'curl https://example.com',
    'wget https://example.com',
    'npm install',
    'pip install requests',
    'node -e "1"',
    'python -c "print(1)"',
    'ls | sh',
    'ls | xargs rm',
    'cat ../outside/secret.txt',
    'cd ..',
    'cd /',
    'ls\nrm x',
    'FOO=1 ls',
    '/bin/rm x',
    'ls &',
    '(ls)',
    'sort -o out.txt src/app.js',
    'uniq src/app.js out.txt',
    'sed -i s/a/b/ src/app.js',
    'awk "{print}" src/app.js',
    "echo 'unterminated",
    'cut -d: -f1 /etc/passwd',
    'tr a b > out.txt',
  ]) test(JSON.stringify(c), () => assert.notEqual(bash(c), null));
  test('cat absolute path outside', () => assert.notEqual(bash(`cat "${path.join(outside, 'secret.txt')}"`), null));
  test('git disabled for dangerous repo config', () => assert.notEqual(bash('git status', { AUDIT_GIT_DISABLED: '1' }), null));
  test('cwd outside roots', () => assert.notEqual(call('Bash', { command: 'ls' }, {}, outside), null));
});

describe('web', () => {
  test('search CVE', () => allowed('WebSearch', { query: 'CVE-2024-4067 micromatch' }));
  test('search KVKK article', () => allowed('WebSearch', { query: 'KVKK madde 9 yurt dışına aktarım standart sözleşme' }));
  test('search license compatibility', () => allowed('WebSearch', { query: 'GPL-3.0 dependency in MIT licensed SaaS' }));
  test('search with email', () => denied('WebSearch', { query: 'ahmet.yilmaz@example.com breach' }));
  test('search with TC kimlik', () => denied('WebSearch', { query: '12345678901 kimdir' }));
  test('search with phone', () => denied('WebSearch', { query: '0532 123 45 67' }));
  test('search with secret', () => denied('WebSearch', { query: 'is sk-proj-abcdefghijklmnopqrstuvwx valid' }));
  test('search with code', () => denied('WebSearch', { query: 'function login(user) { return db.query(sql); }' }));
  test('search too long', () => denied('WebSearch', { query: 'a '.repeat(150) }));
  test('fetch NVD', () => allowed('WebFetch', { url: 'https://nvd.nist.gov/vuln/detail/CVE-2024-4067', prompt: 'summary' }));
  test('fetch localhost', () => denied('WebFetch', { url: 'http://localhost:3000/admin', prompt: 'x' }));
  test('fetch cloud metadata', () => denied('WebFetch', { url: 'http://169.254.169.254/latest/meta-data', prompt: 'x' }));
  test('fetch private LAN', () => denied('WebFetch', { url: 'http://192.168.1.10/', prompt: 'x' }));
  test('fetch file scheme', () => denied('WebFetch', { url: 'file:///etc/passwd', prompt: 'x' }));
  test('fetch with email in query', () => denied('WebFetch', { url: 'https://example.com/?u=ahmet@example.com', prompt: 'x' }));
});

describe('fail-closed', () => {
  test('decide throws without AUDIT_TARGET', () => {
    assert.throws(() => decide({ tool_name: 'Read', tool_input: { file_path: 'x' } }, {}));
  });

  const run = (input, e) => spawnSync(process.execPath, [GUARD], { input: typeof input === 'string' ? input : JSON.stringify(input), env: e, encoding: 'utf8' });

  test('process: allowed call exits 0', () => {
    const r = run({ tool_name: 'Read', tool_input: { file_path: path.join(target, 'src', 'app.js') }, cwd: target }, { ...process.env, ...env });
    assert.equal(r.status, 0, r.stderr);
  });
  test('process: denied call exits 2 with reason', () => {
    const r = run({ tool_name: 'Bash', tool_input: { command: 'rm -rf .' }, cwd: target }, { ...process.env, ...env });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /BLOCKED/);
  });
  test('process: missing AUDIT_TARGET exits 2', () => {
    const e = { ...process.env }; delete e.AUDIT_TARGET;
    const r = run({ tool_name: 'Read', tool_input: { file_path: 'x' } }, e);
    assert.equal(r.status, 2);
  });
  test('process: garbage input exits 2', () => {
    const r = run('not json', { ...process.env, ...env });
    assert.equal(r.status, 2);
  });
  test('process: decisions are logged', () => {
    const runDir = path.join(root, 'run'); fs.mkdirSync(runDir, { recursive: true });
    run({ tool_name: 'Edit', tool_input: { file_path: 'x' }, cwd: target }, { ...process.env, ...env, AUDIT_RUN_DIR: runDir });
    const line = JSON.parse(fs.readFileSync(path.join(runDir, 'guard.log'), 'utf8').trim().split('\n').pop());
    assert.equal(line.decision, 'deny');
    assert.equal(line.tool, 'Edit');
  });
});
