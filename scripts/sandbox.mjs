// Sandbox pre-pass (opt-in): runs the target's own test suite in a throwaway Docker container,
// on a COPY of the target, before the auditor starts. The auditor never runs code itself; it
// reads scans/sandbox.json and the two logs as evidence.
//
// Isolation: copy of the target only (the original is never mounted), no host env vars (so no
// API keys), non-root user, all capabilities dropped, no-new-privileges, memory/cpu/pids limits,
// hard timeouts, container removed afterwards. Phase 1 (dependency install) may use the network
// with lifecycle scripts disabled for npm; phase 2 (tests) always runs with --network none.
// Spec: permissions/POLICY.md → "Sandbox".

import fs from 'node:fs';
import path from 'node:path';
import { findExe, runTool, stageCopy } from './lib.mjs';

const LOG_TAIL_BYTES = 200 * 1024;
const exists = p => { try { fs.accessSync(p); return true; } catch { return false; } };

// ---------------------------------------------------------------- planning (pure)

function hasTestFiles(dir, depth = 0) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return false; }
  for (const e of entries) {
    if (e.isFile() && /^(test_.*|.*_test)\.py$/.test(e.name)) return true;
    if (e.isDirectory() && depth < 2 && !e.name.startsWith('.') && !['node_modules', 'venv', '.venv', '__pycache__'].includes(e.name)) {
      if (hasTestFiles(path.join(dir, e.name), depth + 1)) return true;
    }
  }
  return false;
}

function readText(f) { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } }

// Decide how to run the tests. Returns { kind, image, install, test, note } or { kind: null, reason }.
// Only fixed command templates are used; file names from the target are allow-listed by pattern.
export function detectTestPlan(dir, images = {}) {
  const pkgFile = path.join(dir, 'package.json');
  if (exists(pkgFile)) {
    let pkg = {};
    try { pkg = JSON.parse(readText(pkgFile)); } catch { /* invalid package.json */ }
    const testScript = pkg.scripts?.test;
    if (testScript && !/no test specified/i.test(testScript)) {
      const hasDeps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).length > 0;
      const lock = exists(path.join(dir, 'package-lock.json')) || exists(path.join(dir, 'npm-shrinkwrap.json'));
      return {
        kind: 'node',
        image: images.node ?? 'node:22-bookworm-slim',
        install: hasDeps ? `npm ${lock ? 'ci' : 'install'} --ignore-scripts --no-audit --no-fund` : null,
        test: 'npm test',
        note: `package.json test script: ${String(testScript).slice(0, 120)}${lock ? '' : ' · no lockfile, so versions resolved at install time'}`,
      };
    }
  }

  const top = (() => { try { return fs.readdirSync(dir); } catch { return []; } })();
  const reqFiles = top.filter(f => /^requirements[\w.-]*\.txt$/i.test(f)).sort();
  const testDir = ['tests', 'test'].find(d => exists(path.join(dir, d)));
  const pytestConfig = top.includes('pytest.ini') || top.includes('conftest.py') || /\[tool\.pytest/.test(readText(path.join(dir, 'pyproject.toml')));
  if (pytestConfig || hasTestFiles(dir)) {
    const reqText = reqFiles.map(f => readText(path.join(dir, f))).join('\n');
    const usesPytest = pytestConfig || /^\s*pytest\b/im.test(reqText);
    const venv = '/work/.sbx-venv/bin/python';
    const installs = [];
    if (reqFiles.length) installs.push(...reqFiles.map(f => `${venv} -m pip install -q -r ${f}`));
    if (usesPytest && !/^\s*pytest\b/im.test(reqText)) installs.push(`${venv} -m pip install -q pytest`);
    const py = installs.length ? venv : 'python';
    return {
      kind: 'python',
      image: images.python ?? 'python:3.12-slim-bookworm',
      install: installs.length ? ['python -m venv /work/.sbx-venv', ...installs].join(' && ') : null,
      test: usesPytest ? `${py} -m pytest -q -p no:cacheprovider` : `${py} -m unittest discover${testDir ? ` -s ${testDir}` : ''} -v`,
      note: `${usesPytest ? 'pytest' : 'unittest'}${reqFiles.length ? ` · deps: ${reqFiles.join(', ')}` : ' · no requirements file'}`,
    };
  }
  return { kind: null, reason: 'no test suite detected (no package.json test script, no Python test files)' };
}

// All test suites in the project: the root one, or (when the root has none) one per immediate
// subfolder that has its own, e.g. a monorepo with m1/, m2/ modules. Names come from the file
// system but are only used for log file names (sanitised) and the host-side copy, never in a shell.
// A folder "owns" its tests when it has its own dependency manifest or test config. Modules with
// their own manifest need their own install, so the root plan (which only installs root files)
// cannot cover them.
function ownsManifest(dir) {
  const top = (() => { try { return fs.readdirSync(dir); } catch { return []; } })();
  if (top.some(f => /^requirements[\w.-]*\.txt$/i.test(f)) || top.includes('pytest.ini') || top.includes('conftest.py')) return true;
  if (/\[tool\.pytest/.test(readText(path.join(dir, 'pyproject.toml')))) return true;
  return top.includes('package.json');
}

export function detectTestPlans(dir, images = {}, excludeDirs = []) {
  const root = detectTestPlan(dir, images);
  let subs = [];
  try { subs = fs.readdirSync(dir, { withFileTypes: true }); } catch { /* unreadable */ }
  const modules = [];
  for (const e of subs) {
    if (!e.isDirectory() || e.name.startsWith('.') || excludeDirs.includes(e.name)) continue;
    if (['tests', 'test', '__tests__', 'spec'].includes(e.name)) continue; // the root's own test folder, not a module
    const sub = path.join(dir, e.name);
    const p = detectTestPlan(sub, images);
    if (p.kind) modules.push({ name: e.name.replace(/[^\w.-]+/g, '_'), dir: sub, plan: p, own: ownsManifest(sub) });
  }
  const rootOwns = ownsManifest(dir);
  if (root.kind && (rootOwns || !modules.length)) {
    // root suite, plus every module that brings its own manifest
    return [{ name: '', dir, plan: root }, ...modules.filter(m => m.own).map(({ own, ...m }) => m)]
      .map((s, _i, all) => (all.length > 1 && s.name === '' ? { ...s, name: 'root' } : s));
  }
  return modules.map(({ own, ...m }) => m);
}

export function dockerRunArgs({ name, image, network, mount, user, sb, script }) {
  return [
    'run', '--rm', '--name', name,
    '--network', network,
    '--memory', sb.memory ?? '2g', '--cpus', String(sb.cpus ?? 2), '--pids-limit', String(sb.pidsLimit ?? 512),
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--user', user,
    '-e', 'HOME=/work/.sbx-home', '-e', 'CI=1', '-e', 'npm_config_cache=/work/.sbx-home/.npm',
    '-e', 'PIP_DISABLE_PIP_VERSION_CHECK=1', '-e', 'PYTHONDONTWRITEBYTECODE=1', '-e', 'NO_COLOR=1',
    '-v', `${mount}:/work`, '-w', '/work',
    image, 'sh', '-c', `mkdir -p /work/.sbx-home && ${script}`,
  ];
}

// Best-effort pass/fail counts from common runners' output.
export function parseTestSummary(log) {
  const num = re => { const m = log.match(re); return m ? Number(m[1]) : null; };
  const lastNum = re => { const all = [...log.matchAll(re)]; return all.length ? Number(all[all.length - 1][1]) : null; };
  // pytest: "3 passed, 1 failed in 0.12s"
  if (/=+ .*(passed|failed|error).* in [\d.]+s/.test(log) || /^\d+ (passed|failed)/m.test(log)) {
    return { passed: lastNum(/(\d+) passed/g) ?? 0, failed: (lastNum(/(\d+) failed/g) ?? 0) + (lastNum(/(\d+) errors?\b/g) ?? 0) };
  }
  // unittest: "Ran 7 tests" + "OK" / "FAILED (failures=1, errors=2)"
  const ran = num(/Ran (\d+) tests?/);
  if (ran !== null) {
    const failed = (num(/FAILED \([^)]*failures=(\d+)/) ?? 0) + (num(/FAILED \([^)]*errors=(\d+)/) ?? 0);
    return { passed: ran - failed, failed };
  }
  // node --test (TAP / spec reporter)
  const nodePass = lastNum(/^(?:#|ℹ) pass (\d+)/gm);
  if (nodePass !== null) return { passed: nodePass, failed: lastNum(/^(?:#|ℹ) fail (\d+)/gm) ?? 0 };
  // jest: "Tests:       1 failed, 4 passed, 5 total"
  const jest = log.match(/Tests:\s+(?:(\d+) failed, )?(?:\d+ skipped, )?(\d+) passed/);
  if (jest) return { passed: Number(jest[2]), failed: Number(jest[1] ?? 0) };
  // mocha: "4 passing" / "1 failing"
  const mocha = lastNum(/(\d+) passing/g);
  if (mocha !== null) return { passed: mocha, failed: lastNum(/(\d+) failing/g) ?? 0 };
  return { passed: null, failed: null };
}

// ---------------------------------------------------------------- running

function writeTail(file, text) {
  const buf = Buffer.from(text ?? '', 'utf8');
  fs.writeFileSync(file, buf.length > LOG_TAIL_BYTES ? Buffer.concat([Buffer.from(`[… ${buf.length - LOG_TAIL_BYTES} bytes cut …]\n`), buf.subarray(-LOG_TAIL_BYTES)]) : buf);
}

/**
 * Runs the sandbox and writes <outDir>/sandbox.json (+ logs). Returns the summary entry.
 * opts.docker = { exe, prefix } overrides the docker binary (tests use a fake).
 */
export function runSandbox(target, outDir, { cfg, runId = 'run', log = () => {}, docker } = {}) {
  const sb = cfg.sandbox ?? {};
  const started = Date.now();
  const result = { status: 'skipped' };
  const finish = (extra) => {
    Object.assign(result, extra, { durationMs: Date.now() - started });
    fs.writeFileSync(path.join(outDir, 'sandbox.json'), JSON.stringify(result, null, 2));
    log(`  sandbox: ${result.status}${result.outcome ? ` · ${result.outcome}` : ''}${result.passed != null ? ` (${result.passed} passed, ${result.failed} failed)` : ''}${result.reason ? ` (${result.reason})` : ''}`);
    return result;
  };

  const suites = detectTestPlans(target, sb.images, cfg.excludeDirs);
  if (!suites.length) return finish({ reason: 'no test suite detected (no package.json test script, no Python test files, in the root or any first-level module folder)' });
  const multi = suites[0].name !== '';
  const first = suites[0].plan;
  Object.assign(result, { kind: first.kind, image: first.image, installCommand: first.install, testCommand: first.test, note: first.note });

  const exe = docker?.exe ?? findExe('docker');
  const prefix = docker?.prefix ?? [];
  if (!exe) return finish({ reason: 'docker is not installed' });
  const info = runTool(exe, [...prefix, 'info', '--format', '{{.ServerVersion}}'], { timeout: 30_000 });
  if (info.status !== 0) return finish({ reason: 'docker daemon is not running' });

  const user = process.getuid && process.getuid() !== 0 ? `${process.getuid()}:${process.getgid()}` : '1000:1000';
  const base = `audit-sbx-${runId.replace(/[^\w.-]+/g, '_').slice(-40)}`;

  // Runs one suite on its own copy. Returns a module record; `fatal` set means stop everything.
  const runSuite = ({ name, dir, plan }) => {
    const tag = name ? `${name}-` : '';
    const mod = { module: name || '.', kind: plan.kind, installCommand: plan.install, testCommand: plan.test, note: plan.note };
    const copy = stageCopy(dir, cfg.excludeDirs);
    const phase = (label, script, network, minutes) => {
      const cname = `${base}-${tag}${label}`;
      const r = runTool(exe, [...prefix, ...dockerRunArgs({ name: cname, image: plan.image, network, mount: copy, user, sb, script })], { timeout: minutes * 60_000 });
      const timedOut = r.error?.code === 'ETIMEDOUT' || r.signal === 'SIGTERM';
      if (timedOut) runTool(exe, [...prefix, 'kill', cname], { timeout: 30_000 });
      const output = `$ ${script}\n${r.stdout ?? ''}${r.stderr ?? ''}${timedOut ? `\n[sandbox] killed after ${minutes} min timeout\n` : ''}`;
      writeTail(path.join(outDir, `sandbox-${tag}${label}.log`), output);
      return { exit: timedOut ? null : r.status, timedOut, output };
    };
    try {
      if (plan.install) {
        const net = sb.installNetwork === false ? 'none' : 'bridge';
        const inst = phase('install', plan.install, net, sb.installTimeoutMinutes ?? 10);
        mod.installExit = inst.exit;
        if (inst.timedOut) return { ...mod, status: 'timeout', reason: 'dependency install timed out' };
        if (inst.exit === 125) return { ...mod, status: 'failed', reason: `docker could not start the container (image pull or daemon error); see sandbox-${tag}install.log` };
        if (inst.exit !== 0) return { ...mod, status: 'ran', outcome: 'install-failed' };
      }
      const t = phase('test', plan.test, 'none', sb.testTimeoutMinutes ?? 10);
      mod.testExit = t.exit;
      if (t.timedOut) return { ...mod, status: 'timeout', reason: 'test run timed out' };
      if (t.exit === 125) return { ...mod, status: 'failed', reason: `docker could not start the container; see sandbox-${tag}test.log` };
      const counts = parseTestSummary(t.output);
      const noTests = (plan.test.includes('pytest') && t.exit === 5) || counts.passed === 0 && counts.failed === 0;
      return { ...mod, status: 'ran', outcome: noTests ? 'no-tests-collected' : t.exit === 0 ? 'passed' : 'tests-failed', ...counts };
    } finally {
      try { fs.rmSync(copy, { recursive: true, force: true }); } catch { /* temp copy; OS cleans up */ }
    }
  };

  const mods = suites.map(runSuite);
  const { module: _m, kind: _k, installCommand: _i, testCommand: _t, note: _n, ...single } = mods[0];
  if (!multi) {
    Object.assign(result, { installExit: mods[0].installExit, testExit: mods[0].testExit });
    return finish(single);
  }
  // Several module suites: one verdict for the whole project, per-module detail in `modules`.
  const bad = mods.find(m => m.status === 'timeout' || m.status === 'failed');
  const outcome = mods.some(m => m.outcome === 'tests-failed') ? 'tests-failed'
    : mods.some(m => m.outcome === 'install-failed') ? 'install-failed'
    : mods.every(m => m.outcome === 'no-tests-collected') ? 'no-tests-collected' : 'passed';
  const sum = k => mods.every(m => m[k] == null) ? null : mods.reduce((a, m) => a + (m[k] ?? 0), 0);
  return finish({
    status: bad ? bad.status : 'ran',
    ...(bad ? { reason: `module ${bad.module}: ${bad.reason}` } : { outcome }),
    passed: sum('passed'), failed: sum('failed'),
    modules: mods.map(({ module, kind, status, outcome: o, passed, failed, reason }) => ({ module, kind, status, outcome: o ?? null, passed: passed ?? null, failed: failed ?? null, reason: reason ?? null })),
  });
}
