#!/usr/bin/env node
// Agent performance test: runs real audits on fixture copies and scores them against expected.json.
// Costs real model usage (one Opus audit per fixture), so run on demand, not after every edit.
//
//   node tests/score.mjs                         all fixtures
//   node tests/score.mjs --only webapp-vuln      a subset (comma-separated)
//   node tests/score.mjs --budget 5              per-audit budget override
//   node tests/score.mjs --rescore <runDir>...   re-score archived runs, no model calls
//
// Pass bar (CLAUDE.md, plan): recall ≥ 80% on vuln fixtures, 0 High/Critical on clean-project,
// 0 permission violations.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAudit, lintReport } from '../scripts/audit.mjs';
import { timestamp } from '../scripts/lib.mjs';

const TESTS = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(TESTS, 'fixtures');
const RESULTS = path.join(TESTS, 'results');
const SEV_RANK = { Info: 0, Low: 1, Medium: 2, High: 3, Critical: 4 };
const LINE_TOLERANCE = 5;
const PASS = { recall: 0.8 };

// ---------------------------------------------------------------- matching

const normFile = f => (f ? f.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase() : null);

function fileOk(reported, expectedFiles) {
  if (expectedFiles.includes(null)) return true;
  const r = normFile(reported);
  return !!r && expectedFiles.some(e => r === e.toLowerCase() || r.endsWith('/' + e.toLowerCase()));
}

function lineOk(reported, lines) {
  return Number.isInteger(reported) && reported >= lines[0] - LINE_TOLERANCE && reported <= lines[1] + LINE_TOLERANCE;
}

function keywordOk(title, keywords) {
  const t = String(title ?? '').toLowerCase();
  return keywords.some(k => t.includes(k.toLowerCase()));
}

// A reported finding matches an expected one when the category fits, the file fits, and either the
// line is within tolerance or the title names the issue. One finding may satisfy several expected
// items (the auditor is told to merge findings with a shared root cause).
function matches(f, e) {
  if (!e.categories.includes(f.category)) return null;
  if (!fileOk(f.file, e.files)) return null;
  const byLine = e.lines ? lineOk(f.line, e.lines) : false;
  if (!byLine && !keywordOk(f.title, e.keywords)) return null;
  return { byLine };
}

export function scoreFixture(expected, data) {
  const findings = data?.findings ?? [];
  const perExpected = expected.findings.map(e => {
    const hits = findings.map(f => ({ f, m: matches(f, e) })).filter(x => x.m);
    const best = hits.sort((a, b) => SEV_RANK[b.f.severity] - SEV_RANK[a.f.severity])[0];
    return {
      id: e.id,
      found: !!best,
      by: best?.f.id ?? null,
      locationOk: best ? (e.lines ? hits.some(h => h.m.byLine) : null) : null,
      severityOk: best ? SEV_RANK[best.f.severity] >= SEV_RANK[e.minSeverity] : null,
      reportedSeverity: best?.f.severity ?? null,
      minSeverity: e.minSeverity,
    };
  });
  const matchedIds = new Set(perExpected.filter(p => p.found).map(p => p.by));
  const unmatched = findings.filter(f => !expected.findings.some(e => matches(f, e)));
  const reqs = Object.entries(expected.requirements ?? {}).map(([id, allowed]) => {
    const got = (data?.requirements ?? []).find(r => r.id === id)?.status ?? null;
    return { id, got, allowed, ok: allowed.includes(got) };
  });
  const found = perExpected.filter(p => p.found);
  return {
    expectedCount: expected.findings.length,
    foundCount: found.length,
    recall: expected.findings.length ? found.length / expected.findings.length : null,
    locationAccuracy: ratio(found.filter(p => p.locationOk !== null), p => p.locationOk),
    severityAccuracy: ratio(found, p => p.severityOk),
    verdict: data?.verdict ?? null,
    verdictOk: expected.expectedVerdict.includes(data?.verdict),
    requirementsAccuracy: ratio(reqs, r => r.ok),
    highCritical: findings.filter(f => SEV_RANK[f.severity] >= 3).length,
    perExpected, reqs, matchedIds: [...matchedIds],
    unmatched: unmatched.map(f => `${f.id} [${f.severity}] ${f.file ?? '-'}:${f.line ?? '-'} ${f.title}`),
  };
}

function ratio(arr, pred) { return arr.length ? arr.filter(pred).length / arr.length : null; }
const pct = v => (v === null || v === undefined ? '—' : `${Math.round(v * 100)}%`);

// ---------------------------------------------------------------- running

function copyFixture(name) {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), `audit-fixture-${name}-`));
  fs.cpSync(path.join(FIXTURES, name), dest, {
    recursive: true,
    filter: src => path.basename(src) !== 'expected.json' && !src.includes('__pycache__'),
  });
  return dest;
}

async function runFixture(name, budget) {
  const expected = JSON.parse(fs.readFileSync(path.join(FIXTURES, name, 'expected.json'), 'utf8'));
  const copy = copyFixture(name);
  console.log(`\n▶ ${name}  (copy: ${copy})`);
  let result;
  try {
    result = await runAudit({ target: copy, yes: true, budget }, { quiet: false });
  } catch (e) {
    return { name, error: e.message };
  }
  fs.writeFileSync(path.join(result.runDir, 'fixture.txt'), name);
  fs.rmSync(copy, { recursive: true, force: true });
  return evaluate(name, expected, result);
}

function evaluate(name, expected, result) {
  const reportFile = path.join(result.runDir, 'AUDIT_REPORT.md');
  const data = fs.existsSync(reportFile) ? lintReport(fs.readFileSync(reportFile, 'utf8')).data : null;
  return { name, result, score: scoreFixture(expected, data) };
}

function rescore(runDir) {
  const name = fs.readFileSync(path.join(runDir, 'fixture.txt'), 'utf8').trim();
  const expected = JSON.parse(fs.readFileSync(path.join(FIXTURES, name, 'expected.json'), 'utf8'));
  const result = JSON.parse(fs.readFileSync(path.join(runDir, 'result.json'), 'utf8'));
  return evaluate(name, expected, result);
}

// ---------------------------------------------------------------- report

function writeScoreboard(rows) {
  const vuln = rows.filter(r => r.score && r.name !== 'clean-project');
  const clean = rows.find(r => r.name === 'clean-project');
  const totalExpected = vuln.reduce((s, r) => s + r.score.expectedCount, 0);
  const totalFound = vuln.reduce((s, r) => s + r.score.foundCount, 0);
  const overallRecall = totalExpected ? totalFound / totalExpected : null;
  const violations = rows.reduce((s, r) => s + (r.result?.violations?.length ?? 0), 0);
  const cleanFP = clean?.score?.highCritical ?? null;
  const cost = rows.reduce((s, r) => s + (r.result?.costUsd ?? 0), 0);

  const checks = [
    [`Recall ≥ ${pct(PASS.recall)} on vuln fixtures`, overallRecall !== null && overallRecall >= PASS.recall, pct(overallRecall)],
    ['0 High/Critical on clean-project', clean ? cleanFP === 0 : null, clean ? String(cleanFP) : 'not run'],
    ['0 permission violations', violations === 0, String(violations)],
  ];
  const passed = checks.every(c => c[1] !== false);

  const lines = [
    `# Audit harness scoreboard: ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`,
    '',
    `**Result: ${passed ? 'PASS' : 'FAIL'}** · total cost ${cost ? `$${cost.toFixed(2)}` : '—'}`,
    '',
    '| Check | Pass | Value |', '|---|---|---|',
    ...checks.map(([n, ok, v]) => `| ${n} | ${ok === null ? '—' : ok ? '✅' : '❌'} | ${v} |`),
    '',
    '| Fixture | Recall | Location | Severity | Verdict | Reqs | High/Crit | Violations | Blocked calls | Cost | Exit |',
    '|---|---|---|---|---|---|---|---|---|---|---|',
    ...rows.map(r => r.error
      ? `| ${r.name} | ERROR: ${r.error} |||||||||| |`
      : `| ${r.name} | ${r.score.foundCount}/${r.score.expectedCount} ${pct(r.score.recall)} | ${pct(r.score.locationAccuracy)} | ${pct(r.score.severityAccuracy)} | ${r.score.verdict ?? '—'} ${r.score.verdictOk ? '✅' : '❌'} | ${pct(r.score.requirementsAccuracy)} | ${r.score.highCritical} | ${r.result.violations.length} | ${r.result.deniedCalls} | ${r.result.costUsd != null ? `$${r.result.costUsd.toFixed(2)}` : '—'} | ${r.result.exitCode} |`),
    '',
  ];
  for (const r of rows.filter(x => x.score)) {
    lines.push(`## ${r.name}`, '', `Run: \`${r.result.runDir}\``, '');
    lines.push('| Expected | Found | By | Severity (min) | Location |', '|---|---|---|---|---|');
    for (const p of r.score.perExpected) {
      lines.push(`| ${p.id} | ${p.found ? '✅' : '❌'} | ${p.by ?? ''} | ${p.reportedSeverity ?? '—'} (${p.minSeverity})${p.severityOk === false ? ' ⚠' : ''} | ${p.locationOk === null ? '—' : p.locationOk ? '✅' : '⚠'} |`);
    }
    if (r.score.reqs.length) {
      lines.push('', '| Requirement | Reported | Accepted | OK |', '|---|---|---|---|');
      for (const q of r.score.reqs) lines.push(`| ${q.id} | ${q.got ?? '—'} | ${q.allowed.join(' / ')} | ${q.ok ? '✅' : '❌'} |`);
    }
    if (r.score.unmatched.length) {
      lines.push('', '<details><summary>Findings not in the answer key (review manually: real extras or false positives?)</summary>', '');
      lines.push(...r.score.unmatched.map(u => `- ${u}`), '', '</details>');
    }
    lines.push('');
  }
  fs.mkdirSync(RESULTS, { recursive: true });
  const file = path.join(RESULTS, `${timestamp()}.md`);
  fs.writeFileSync(file, lines.join('\n'));
  fs.writeFileSync(file.replace(/\.md$/, '.json'), JSON.stringify(rows.map(r => ({ name: r.name, error: r.error, score: r.score, runDir: r.result?.runDir, costUsd: r.result?.costUsd, exitCode: r.result?.exitCode })), null, 2));
  console.log('\n' + lines.slice(0, 12 + rows.length).join('\n'));
  console.log(`\nScoreboard: ${file}`);
  return passed;
}

// ---------------------------------------------------------------- CLI

async function main() {
  const argv = process.argv.slice(2);
  let only = null, budget, rescoreDirs = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--only') only = argv[++i].split(',');
    else if (argv[i] === '--budget') budget = Number(argv[++i]);
    else if (argv[i] === '--rescore') rescoreDirs = argv.slice(i + 1);
  }
  let rows;
  if (rescoreDirs) {
    rows = rescoreDirs.map(d => rescore(path.resolve(d)));
  } else {
    const names = fs.readdirSync(FIXTURES).filter(n => fs.existsSync(path.join(FIXTURES, n, 'expected.json')) && (!only || only.includes(n)));
    rows = [];
    for (const n of names) rows.push(await runFixture(n, budget));
  }
  process.exit(writeScoreboard(rows) ? 0 : 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
