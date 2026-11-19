// Coverage helpers: module inventory and Python dependency-file discovery (pip-audit input).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildInventory, loadConfig } from '../scripts/lib.mjs';
import { findPythonDepFiles } from '../scripts/run-scanners.mjs';

function tmpProject(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cov-proj-'));
  for (const [f, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), content);
  }
  return dir;
}

describe('buildInventory', () => {
  const cfg = loadConfig();
  test('counts files and lines per first-level module, skips excluded dirs', () => {
    const d = tmpProject({
      'app.py': 'a\nb\n', 'm1/x.py': 'a\n', 'm2/y.py': '1\n2\n3\n', 'm2/sub/z.js': 'q\n',
      'node_modules/pkg/i.js': 'skip\n', 'm1/notes.txt': 'not source\n',
    });
    const inv = buildInventory(d, cfg);
    assert.equal(inv.totalFiles, 4);
    const by = Object.fromEntries(inv.modules.map(m => [m.module, m.files]));
    assert.deepEqual(by, { '.': 1, m1: 1, m2: 2 });
    assert.ok(!inv.modules.some(m => m.module === 'node_modules'));
  });
});

describe('findPythonDepFiles', () => {
  const cfg = loadConfig();
  test('finds requirements files at any depth and pyproject dependencies', () => {
    const d = tmpProject({
      'requirements.txt': 'requests\n',
      'm2/requirements-dev.txt': 'pytest\n',
      'm3/pyproject.toml': '[project]\nname="x"\ndependencies = [\n  "flask>=2",\n  "httpx==0.27.0",\n]\n',
      'm4/pyproject.toml': '[project]\nname="no-deps"\n',
      'venv/requirements.txt': 'ignored\n',
    });
    const found = findPythonDepFiles(d, cfg.excludeDirs);
    assert.deepEqual(found.map(f => f.rel), ['m2/requirements-dev.txt', 'm3/pyproject.toml', 'requirements.txt']);
    assert.deepEqual(found.find(f => f.pyproject).pyproject, ['flask>=2', 'httpx==0.27.0']);
  });
});
