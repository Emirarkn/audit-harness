// Deterministic scanner pre-pass. Runs installed scanners against the target with fixed,
// read-only arguments and writes their output to <runDir>/scans/. Never writes into the target.
// Usage (standalone): node scripts/run-scanners.mjs <target> <outDir>

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findExe, runTool, walk, loadConfig, stageCopy } from './lib.mjs';

function exists(p) { try { fs.accessSync(p); return true; } catch { return false; } }

function readJsonOk(file) {
  try { JSON.parse(fs.readFileSync(file, 'utf8')); return true; } catch { return false; }
}

// Python dependency declarations at any depth: requirements*.txt files and, when a pyproject.toml
// has a [project] dependencies array, those entries (simple string extraction, no TOML parser).
export function findPythonDepFiles(target, excludeDirs) {
  const found = [];
  walk(target, excludeDirs, (f) => {
    const base = path.basename(f);
    const rel = path.relative(target, f).split(path.sep).join('/');
    if (/^requirements[\w.-]*\.txt$/i.test(base)) found.push({ abs: f, rel });
    else if (base === 'pyproject.toml') {
      let text = '';
      try { text = fs.readFileSync(f, 'utf8'); } catch { return; }
      const m = text.match(/^\s*dependencies\s*=\s*\[([\s\S]*?)\]/m);
      const deps = m ? [...m[1].matchAll(/["']([^"']+)["']/g)].map(x => x[1]) : [];
      if (deps.length) found.push({ abs: f, rel, pyproject: deps });
    }
  });
  return found.sort((a, b) => a.rel.localeCompare(b.rel));
}

export function runScanners(target, outDir, { env = process.env, gitEnabled = true, log = () => {} } = {}) {
  const cfg = loadConfig();
  const timeout = cfg.scannerTimeoutMinutes * 60 * 1000;
  fs.mkdirSync(outDir, { recursive: true });
  const summary = {};
  const out = name => path.join(outDir, name);

  let hasPy = false, hasJs = false;
  walk(target, cfg.excludeDirs, f => {
    if (f.endsWith('.py')) hasPy = true;
    if (/\.(m?js|cjs|jsx|tsx?)$/.test(f)) hasJs = true;
  });
  const lockfile = ['package-lock.json', 'npm-shrinkwrap.json'].find(f => exists(path.join(target, f)));

  const record = (name, status, extra = {}) => { summary[name] = { status, ...extra }; log(`  scanner ${name}: ${status}${extra.note ? ` (${extra.note})` : ''}`); };

  // gitleaks: secrets in the working tree (+ git history when git is safe to use). --redact keeps
  // raw secret values out of the scan file the model reads.
  {
    const exe = findExe('gitleaks');
    if (!exe) record('gitleaks', 'missing');
    else {
      const f = out('gitleaks-dir.json');
      let r = runTool(exe, ['dir', target, '--report-format', 'json', '--report-path', f, '--redact', '--no-banner', '--exit-code', '0'], { env, timeout });
      if (r.status !== 0 || !exists(f)) {
        r = runTool(exe, ['detect', '--no-git', '--source', target, '--report-format', 'json', '--report-path', f, '--redact', '--no-banner', '--exit-code', '0'], { env, timeout });
      }
      const files = [];
      if (exists(f) && readJsonOk(f)) files.push(path.basename(f));
      if (gitEnabled && exists(path.join(target, '.git'))) {
        const g = out('gitleaks-history.json');
        const rg = runTool(exe, ['git', target, '--report-format', 'json', '--report-path', g, '--redact', '--no-banner', '--exit-code', '0'], { env, timeout });
        if (rg.status === 0 && exists(g)) files.push(path.basename(g));
      }
      files.length ? record('gitleaks', 'ran', { files }) : record('gitleaks', 'failed', { note: (r.stderr || '').trim().slice(0, 300) });
    }
  }

  // osv-scanner: known CVEs in dependencies, all ecosystems (v2 syntax first, then v1).
  {
    const exe = findExe('osv-scanner');
    if (!exe) record('osv-scanner', 'missing');
    else {
      const f = out('osv-scanner.json');
      let r = runTool(exe, ['scan', 'source', '-r', target, '--format', 'json', '--output', f], { env, timeout });
      if (!exists(f)) r = runTool(exe, ['--recursive', target, '--format', 'json', '--output', f], { env, timeout });
      if (exists(f) && readJsonOk(f)) record('osv-scanner', 'ran', { files: [path.basename(f)] });
      else if (/no package sources found/i.test(`${r.stdout}${r.stderr}`)) record('osv-scanner', 'n/a', { note: 'no lockfiles/manifests found' });
      else record('osv-scanner', 'failed', { note: `${r.stderr || r.stdout || r.error?.message || ''}`.trim().slice(0, 300) });
    }
  }

  // semgrep: code patterns (injection, unsafe APIs). Needs network to fetch the ruleset.
  // On Windows it silently scans 0 files under non-ASCII paths, so it always runs on an ASCII
  // staging copy with cwd = copy and target "." (result paths are then relative to the target).
  {
    const exe = findExe('semgrep') || findExe('pysemgrep');
    if (!exe) record('semgrep', 'missing');
    else {
      const f = out('semgrep.json');
      const stage = stageCopy(target, cfg.excludeDirs);
      try {
        const r = runTool(exe, ['scan', '--config', 'p/default', '--json', '--output', f, '--metrics', 'off', '--quiet', '--disable-version-check', '.'], { cwd: stage, env, timeout });
        let scanned = -1;
        try { scanned = JSON.parse(fs.readFileSync(f, 'utf8')).paths?.scanned?.length ?? -1; } catch { /* handled below */ }
        if (scanned > 0) record('semgrep', 'ran', { files: [path.basename(f)], note: `${scanned} files scanned` });
        else if (scanned === 0) record('semgrep', 'failed', { note: 'scanned 0 files (path or ruleset problem)' });
        else record('semgrep', 'failed', { note: `${r.stderr || r.error?.message || ''}`.trim().slice(0, 300) });
      } finally {
        fs.rmSync(stage, { recursive: true, force: true });
      }
    }
  }

  // npm audit: JS dependency advisories, from the lockfile only (no install, no scripts).
  if (!lockfile) record('npm-audit', 'n/a', { note: hasJs ? 'JS code but no package-lock.json: dependency versions unpinned' : 'no JS lockfile' });
  else {
    const exe = findExe('npm');
    if (!exe) record('npm-audit', 'missing');
    else {
      const r = runTool(exe, ['audit', '--json', '--package-lock-only'], { cwd: target, env, timeout });
      const f = out('npm-audit.json');
      fs.writeFileSync(f, r.stdout || '');
      readJsonOk(f) ? record('npm-audit', 'ran', { files: [path.basename(f)] }) : record('npm-audit', 'failed', { note: (r.stderr || '').trim().slice(0, 300) });
    }
  }

  // pip-audit: Python dependency advisories, for EVERY requirements*.txt at any depth (module
  // folders included) and for [project].dependencies in pyproject.toml (extracted to a temp file,
  // the project itself is never built). Pass 1 is --no-deps/--disable-pip: never installs or runs
  // setup.py, but needs pinned versions. If a file has unpinned entries, pass 2 lets pip-audit
  // resolve them in its own throwaway venv with PIP_ONLY_BINARY=:all:, so no sdist is ever built
  // and no setup.py runs. Anything still unaudited makes the status 'partial', not 'ran'.
  const pyDeps = findPythonDepFiles(target, cfg.excludeDirs);
  if (!pyDeps.length) record('pip-audit', 'n/a', { note: hasPy ? 'Python code but no requirements*.txt or pyproject.toml dependencies' : 'no Python requirements' });
  else {
    const exe = findExe('pip-audit');
    if (!exe) record('pip-audit', 'missing');
    else {
      const files = [], notes = [];
      const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-pip-'));
      try {
        for (const dep of pyDeps) {
          const label = dep.rel.replace(/\W+/g, '_');
          const f = out(`pip-audit-${label}.json`);
          let reqPath = dep.abs;
          if (dep.pyproject) {
            reqPath = path.join(stage, `${label}.txt`);
            fs.writeFileSync(reqPath, dep.pyproject.join('\n') + '\n');
          }
          const fmt = ['--format', 'json', '--output', f, '--progress-spinner', 'off'];
          let r = runTool(exe, ['-r', reqPath, '--no-deps', '--disable-pip', ...fmt], { env, timeout });
          if (!(exists(f) && readJsonOk(f))) {
            try { fs.rmSync(f, { force: true }); } catch { /* none */ }
            r = runTool(exe, ['-r', reqPath, ...fmt], { env: { ...env, PIP_ONLY_BINARY: ':all:' }, timeout });
          }
          if (exists(f) && readJsonOk(f)) files.push(path.basename(f));
          else notes.push(`${dep.rel}: NOT AUDITED, ${(r.stderr || r.stdout || '').trim().split('\n').pop()?.slice(0, 200)}`);
        }
      } finally {
        fs.rmSync(stage, { recursive: true, force: true });
      }
      if (!files.length) record('pip-audit', 'failed', { note: notes.join('; ') });
      else if (notes.length) record('pip-audit', 'partial', { files, note: notes.join('; ') });
      else record('pip-audit', 'ran', { files, note: `${files.length} dependency file(s) audited` });
    }
  }

  // bandit: Python security linter.
  if (!hasPy) record('bandit', 'n/a', { note: 'no Python files' });
  else {
    const exe = findExe('bandit');
    if (!exe) record('bandit', 'missing');
    else {
      const f = out('bandit.json');
      const excludes = cfg.excludeDirs.map(d => path.join(target, d)).join(',');
      const r = runTool(exe, ['-r', target, '-f', 'json', '-o', f, '-q', '-x', excludes], { env, timeout });
      exists(f) && readJsonOk(f) ? record('bandit', 'ran', { files: [path.basename(f)] }) : record('bandit', 'failed', { note: (r.stderr || '').trim().slice(0, 300) });
    }
  }

  fs.writeFileSync(out('_summary.json'), JSON.stringify(summary, null, 2));
  return summary;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [target, outDir] = process.argv.slice(2);
  if (!target || !outDir) { console.error('usage: node scripts/run-scanners.mjs <target> <outDir>'); process.exit(4); }
  runScanners(path.resolve(target), path.resolve(outDir), { log: console.log });
}
