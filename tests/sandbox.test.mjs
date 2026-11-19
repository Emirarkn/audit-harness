// Sandbox pre-pass: test planning, container hardening flags, result parsing, and the run flow
// against a fake docker CLI. Free: no Docker or model calls needed.

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectTestPlan, detectTestPlans, dockerRunArgs, parseTestSummary, runSandbox } from '../scripts/sandbox.mjs';
import { loadConfig } from '../scripts/lib.mjs';

const TESTS = path.dirname(fileURLToPath(import.meta.url));
const FIX = name => path.join(TESTS, 'fixtures', name);
const FAKE = path.join(TESTS, 'helpers', 'fake-docker.mjs');

function tmpProject(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-proj-'));
  for (const [f, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), content);
  }
  return dir;
}

describe('detectTestPlan', () => {
  test('clean-project: unittest, no install phase', () => {
    const p = detectTestPlan(FIX('clean-project'));
    assert.equal(p.kind, 'python');
    assert.equal(p.install, null);
    assert.equal(p.test, 'python -m unittest discover -s tests -v');
  });
  test('projects without tests: nothing to run', () => {
    for (const f of ['webapp-vuln', 'llm-agent-vuln', 'script-vuln']) assert.equal(detectTestPlan(FIX(f)).kind, null, f);
  });
  test('node: npm test with lifecycle scripts disabled', () => {
    const d = tmpProject({ 'package.json': JSON.stringify({ scripts: { test: 'node --test' }, dependencies: { express: '^4' } }) });
    const p = detectTestPlan(d);
    assert.equal(p.kind, 'node');
    assert.equal(p.install, 'npm install --ignore-scripts --no-audit --no-fund');
    assert.equal(p.test, 'npm test');
    fs.writeFileSync(path.join(d, 'package-lock.json'), '{}');
    assert.match(detectTestPlan(d).install, /^npm ci --ignore-scripts/);
  });
  test('npm default "no test specified" script is not a test suite', () => {
    const d = tmpProject({ 'package.json': JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }) });
    assert.equal(detectTestPlan(d).kind, null);
  });
  test('python with pytest in requirements: venv install, pytest run', () => {
    const d = tmpProject({ 'requirements.txt': 'requests==2.32.0\npytest==8.3.0\n', 'tests/test_a.py': 'def test_a(): pass\n' });
    const p = detectTestPlan(d);
    assert.match(p.install, /python -m venv \/work\/\.sbx-venv && .* -m pip install -q -r requirements\.txt$/);
    assert.equal(p.test, '/work/.sbx-venv/bin/python -m pytest -q -p no:cacheprovider');
  });
  test('target file names never reach the shell unless they match the allowlist', () => {
    const d = tmpProject({ 'requirements$(touch x).txt': 'x\n', 'requirements-dev.txt': 'pytest\n', 'test_a.py': '' });
    const p = detectTestPlan(d);
    assert.ok(!p.install.includes('$('));
    assert.ok(p.install.includes('requirements-dev.txt'));
  });
});

describe('dockerRunArgs', () => {
  const args = dockerRunArgs({ name: 'n', image: 'python:3.12-slim', network: 'none', mount: '/tmp/copy', user: '1000:1000', sb: {}, script: 'python -m unittest' });
  const pair = (k, v) => args.some((a, i) => a === k && args[i + 1] === v);
  test('hardening flags', () => {
    assert.ok(pair('--network', 'none'));
    assert.ok(pair('--cap-drop', 'ALL'));
    assert.ok(pair('--security-opt', 'no-new-privileges'));
    assert.ok(pair('--user', '1000:1000'));
    assert.ok(pair('--memory', '2g') && pair('--pids-limit', '512'));
    assert.ok(args.includes('--rm'));
  });
  test('only the copy is mounted and no host env is passed', () => {
    assert.ok(pair('-v', '/tmp/copy:/work'));
    const envs = args.filter((a, i) => args[i - 1] === '-e');
    assert.ok(envs.every(e => /^(HOME|CI|npm_config_cache|PIP_DISABLE_PIP_VERSION_CHECK|PYTHONDONTWRITEBYTECODE|NO_COLOR)=/.test(e)), envs.join());
  });
});

describe('parseTestSummary', () => {
  test('pytest', () => assert.deepEqual(parseTestSummary('==== 3 passed, 1 failed in 0.12s ===='), { passed: 3, failed: 1 }));
  test('unittest OK', () => assert.deepEqual(parseTestSummary('Ran 7 tests in 0.002s\n\nOK'), { passed: 7, failed: 0 }));
  test('unittest FAILED', () => assert.deepEqual(parseTestSummary('Ran 7 tests\n\nFAILED (failures=1, errors=2)'), { passed: 4, failed: 3 }));
  test('node --test', () => assert.deepEqual(parseTestSummary('# tests 5\n# pass 4\n# fail 1\n'), { passed: 4, failed: 1 }));
  test('jest', () => assert.deepEqual(parseTestSummary('Tests:       1 failed, 4 passed, 5 total'), { passed: 4, failed: 1 }));
  test('mocha', () => assert.deepEqual(parseTestSummary('  4 passing (20ms)\n  1 failing'), { passed: 4, failed: 1 }));
  test('unknown output', () => assert.deepEqual(parseTestSummary('hello'), { passed: null, failed: null }));
});

describe('runSandbox (fake docker)', () => {
  const cfg = loadConfig();
  let out, logFile;
  const calls = () => fs.readFileSync(logFile, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  const run = (target, mode) => {
    process.env.FAKE_DOCKER_MODE = mode;
    return runSandbox(target, out, { cfg, runId: 't', docker: { exe: process.execPath, prefix: [FAKE] } });
  };
  beforeEach(() => {
    out = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-out-'));
    logFile = path.join(out, 'calls.jsonl');
    process.env.FAKE_DOCKER_LOG = logFile;
  });

  test('passing suite: tests run offline on a copy, never on the target', () => {
    const r = run(FIX('clean-project'), 'pass');
    assert.equal(r.status, 'ran');
    assert.equal(r.outcome, 'passed');
    assert.deepEqual([r.passed, r.failed], [3, 0]);
    const runs = calls().filter(c => c[0] === 'run');
    assert.equal(runs.length, 1, 'no install phase for a stdlib-only project');
    const a = runs[0];
    assert.equal(a[a.indexOf('--network') + 1], 'none');
    const mount = a[a.indexOf('-v') + 1];
    assert.ok(!mount.startsWith(FIX('clean-project')), 'target itself is never mounted');
    assert.ok(fs.existsSync(path.join(out, 'sandbox.json')) && fs.existsSync(path.join(out, 'sandbox-test.log')));
  });
  test('install phase may use the network, test phase never does', () => {
    const d = tmpProject({ 'requirements.txt': 'pytest\n', 'tests/test_a.py': '' });
    run(d, 'pass');
    const nets = calls().filter(c => c[0] === 'run').map(a => a[a.indexOf('--network') + 1]);
    assert.deepEqual(nets, ['bridge', 'none']);
  });
  test('failing suite', () => {
    const r = run(FIX('clean-project'), 'fail');
    assert.equal(r.outcome, 'tests-failed');
    assert.equal(r.failed, 1);
  });
  test('docker cannot start the container: infrastructure failure, not a project defect', () => {
    assert.equal(run(FIX('clean-project'), 'pull-error').status, 'failed');
  });
  test('docker daemon down: skipped', () => {
    const r = run(FIX('clean-project'), 'down');
    assert.equal(r.status, 'skipped');
    assert.match(r.reason, /daemon/);
  });
  test('module folders: each first-level module with tests runs on its own copy', () => {
    const d = tmpProject({
      'm1/requirements.txt': 'pytest\n', 'm1/tests/test_a.py': '',
      'm2/test_b.py': '', 'docs/readme.txt': 'x',
    });
    assert.deepEqual(detectTestPlans(d, {}, []).map(s => s.name), ['m1', 'm2']);
    const r = run(d, 'pass');
    assert.equal(r.status, 'ran');
    assert.equal(r.modules.length, 2);
    assert.deepEqual(r.modules.map(m => m.module), ['m1', 'm2']);
    assert.ok(fs.existsSync(path.join(out, 'sandbox-m1-test.log')) && fs.existsSync(path.join(out, 'sandbox-m2-test.log')));
    const mounts = calls().filter(c => c[0] === 'run').map(a => a[a.indexOf('-v') + 1]);
    assert.ok(mounts.every(m => !m.startsWith(d)), 'originals are never mounted');
  });
  test('module failure makes the whole run tests-failed', () => {
    const d = tmpProject({ 'm1/test_a.py': '', 'm2/test_b.py': '' });
    assert.equal(run(d, 'fail').outcome, 'tests-failed');
  });
  test('no test suite: skipped without calling docker', () => {
    const r = run(FIX('webapp-vuln'), 'pass');
    assert.equal(r.status, 'skipped');
    assert.ok(!fs.existsSync(logFile));
  });
});
