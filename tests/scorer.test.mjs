// Unit tests for the report linter (scripts/audit.mjs) and the fixture scorer (tests/score.mjs).
// Free: no model calls.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { lintReport, REQUIRED_HEADINGS, parseArgs, inspectGit } from '../scripts/audit.mjs';
import { scoreFixture } from './score.mjs';

function report(json) {
  const body = REQUIRED_HEADINGS.filter(h => !h.startsWith('## Appendix')).map(h => `${h}\n\ntext\n`).join('\n');
  return `# Audit Report — x\n\n${body}\n## Appendix — findings-json\n\`\`\`findings-json\n${JSON.stringify(json, null, 2)}\n\`\`\`\n`;
}

const good = {
  verdict: 'Do not ship', confidence: 'High',
  counts: { Critical: 1, High: 1, Medium: 0, Low: 0, Info: 0 },
  requirements: [{ id: 'R1', status: 'Contradicted' }, { id: 'R5', status: 'Missing' }],
  findings: [
    { id: 'SEC-001', category: 'security', severity: 'Critical', evidence: 'Verified', kind: 'incorrect', effort: 'S', file: 'src/db.js', line: 7, title: 'SQL injection via string concatenation', fix: 'Use parameterised queries in src/db.js' },
    { id: 'SEC-002', category: 'security', severity: 'High', evidence: 'Verified', kind: 'weak', effort: 'S', file: 'src/config.js', line: 4, title: 'Hard-coded JWT secret', fix: 'Read JWT_SECRET from the environment and fail at startup if unset' },
  ],
};

test('lint: valid report passes', () => {
  const { errors, data } = lintReport(report(good));
  assert.deepEqual(errors, []);
  assert.equal(data.verdict, 'Do not ship');
});

test('lint: count mismatch is caught', () => {
  const bad = structuredClone(good); bad.counts.High = 3;
  assert.ok(lintReport(report(bad)).errors.some(e => e.includes('counts.High')));
});

test('lint: invalid enum values are caught', () => {
  const bad = structuredClone(good);
  bad.verdict = 'Maybe'; bad.findings[0].category = 'misc'; bad.findings[1].evidence = 'Guess';
  const { errors } = lintReport(report(bad));
  assert.equal(errors.length, 3);
});

test('lint: kind, effort and fix are required on every finding', () => {
  const bad = structuredClone(good);
  bad.findings[0].kind = 'broken'; delete bad.findings[0].effort; bad.findings[1].fix = '';
  const { errors } = lintReport(report(bad));
  assert.ok(errors.some(e => e.includes('invalid kind')));
  assert.ok(errors.some(e => e.includes('invalid effort')));
  assert.ok(errors.some(e => e.includes('missing fix')));
});

test('lint: missing heading and missing JSON block are caught', () => {
  const text = report(good).replace('## 8. Privacy policy vs. actual behaviour', '## 8. Privacy');
  assert.ok(lintReport(text).errors.some(e => e.includes('missing heading')));
  assert.ok(lintReport('# nothing').errors.some(e => e.includes('findings-json')));
});

test('score: matches by file + line and by keyword, reports misses', () => {
  const expected = {
    expectedVerdict: ['Do not ship'],
    findings: [
      { id: 'sqli', categories: ['security'], minSeverity: 'High', files: ['src/db.js'], lines: [7, 7], keywords: ['sql'] },
      { id: 'secret', categories: ['security'], minSeverity: 'Critical', files: ['src/config.js'], lines: [40, 40], keywords: ['secret'] },
      { id: 'missing', categories: ['legal'], minSeverity: 'Medium', files: [null], lines: null, keywords: ['kvkk'] },
    ],
    requirements: { R1: ['Contradicted', 'Partial'], R5: ['Missing'], R7: ['Missing'] },
  };
  const s = scoreFixture(expected, good);
  assert.equal(s.foundCount, 2);
  assert.equal(s.perExpected[0].locationOk, true);
  assert.equal(s.perExpected[1].locationOk, false, 'line 4 vs expected 40: matched by keyword only');
  assert.equal(s.perExpected[1].severityOk, false, 'High < Critical');
  assert.equal(s.perExpected[2].found, false);
  assert.equal(s.verdictOk, true);
  assert.equal(s.requirementsAccuracy, 2 / 3);
  assert.equal(s.highCritical, 2);
});

test('score: wrong category does not match', () => {
  const expected = { expectedVerdict: ['Ship'], findings: [{ id: 'x', categories: ['privacy'], minSeverity: 'Low', files: ['src/db.js'], lines: [7, 7], keywords: [] }] };
  assert.equal(scoreFixture(expected, good).foundCount, 0);
});

test('every fixture has a well-formed answer key', () => {
  const dir = new URL('./fixtures/', import.meta.url);
  for (const name of fs.readdirSync(dir).filter(n => fs.statSync(new URL(n, dir)).isDirectory())) {
    const e = JSON.parse(fs.readFileSync(new URL(`${name}/expected.json`, dir), 'utf8'));
    assert.ok(Array.isArray(e.expectedVerdict) && e.expectedVerdict.length, `${name}: expectedVerdict`);
    for (const f of e.findings) {
      assert.ok(f.id && f.categories?.length && f.minSeverity && Array.isArray(f.files) && Array.isArray(f.keywords), `${name}: ${f.id}`);
      for (const file of f.files) if (file) assert.ok(fs.existsSync(new URL(`${name}/${file}`, dir)), `${name}: ${file} exists`);
    }
  }
});

test('runner: argument parsing', () => {
  const o = parseArgs(['C:/p', '--request', 'build x', '--budget', '5', '--yes']);
  assert.equal(o.target, 'C:/p'); assert.equal(o.request, 'build x'); assert.equal(o.budget, 5); assert.equal(o.yes, true);
  assert.equal(o.sandbox, null);
  assert.equal(parseArgs(['p', '--sandbox']).sandbox, true);
  assert.equal(parseArgs(['p', '--no-sandbox']).sandbox, false);
  assert.throws(() => parseArgs(['--bogus']));
  assert.throws(() => parseArgs(['a', 'b']));
});

test('runner: dangerous git config disables git', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitcfg-'));
  fs.mkdirSync(`${dir}/.git`);
  fs.writeFileSync(`${dir}/.git/config`, '[core]\n\tfsmonitor = ./evil.sh\n');
  assert.equal(inspectGit(dir).enabled, false);
  fs.writeFileSync(`${dir}/.git/config`, '[core]\n\trepositoryformatversion = 0\n');
  assert.equal(inspectGit(dir).enabled, true);
  fs.rmSync(dir, { recursive: true, force: true });
});
