#!/usr/bin/env node
// GitHub integration: turns AUDIT_REPORT.md into a short PR comment (verdict, counts, top findings
// with their fixes, the "Before release" fix plan) and a job summary. One sticky comment per PR,
// updated on each run. Used by ci/github/project-audit.yml.
//
//   node scripts/pr-comment.mjs <AUDIT_REPORT.md> [--post] [--exit-code <n>]
//
// Env (set by GitHub Actions): GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_EVENT_PATH, GITHUB_API_URL,
// GITHUB_SERVER_URL, GITHUB_RUN_ID, GITHUB_STEP_SUMMARY.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lintReport } from './audit.mjs';

export const MARKER = '<!-- audit-harness -->';
const SEV_RANK = { Critical: 4, High: 3, Medium: 2, Low: 1, Info: 0 };
const VERDICT_ICON = { 'Ship': '✅', 'Ship with fixes': '⚠️', 'Do not ship': '❌' };
const EXIT_TEXT = { 3: 'permission violation: the auditor changed files it must not touch', 4: 'run error: no valid report was produced' };
const MAX_BODY = 60000; // GitHub's limit is 65536 characters

const cell = (s, n = 160) => {
  const t = String(s ?? '').replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

function section(text, start, end) {
  const a = text.indexOf(start);
  if (a < 0) return '';
  const b = end ? text.indexOf(end, a + start.length) : -1;
  return text.slice(a + start.length, b < 0 ? undefined : b).trim();
}

export function buildComment(reportText, { runUrl = null, exitCode = null, maxFindings = 15 } = {}) {
  const lines = [MARKER];
  const footer = runUrl ? `\n_Full report and run artifacts: [workflow run](${runUrl})._` : '';
  if (!reportText) {
    lines.push('## Final-stage audit: ❌ no report', '', `The audit did not produce a report (${EXIT_TEXT[exitCode] ?? `exit code ${exitCode ?? 'unknown'}`}).`);
    return lines.join('\n') + footer;
  }
  const { errors, data } = lintReport(reportText);
  if (!data) {
    lines.push('## Final-stage audit: ❌ unreadable report', '', ...errors.slice(0, 10).map(e => `- ${cell(e, 300)}`));
    return lines.join('\n') + footer;
  }
  const c = data.counts ?? {};
  const findings = [...(data.findings ?? [])].sort((a, b) => (SEV_RANK[b.severity] ?? 0) - (SEV_RANK[a.severity] ?? 0));
  const tally = (key, values) => values.map(v => `${v} ${findings.filter(f => f[key] === v).length}`).join(' · ');

  lines.push(
    `## Final-stage audit: ${VERDICT_ICON[data.verdict] ?? ''} ${data.verdict} (confidence ${data.confidence})`,
    '',
    `**Findings:** Critical ${c.Critical ?? 0} · High ${c.High ?? 0} · Medium ${c.Medium ?? 0} · Low ${c.Low ?? 0} · Info ${c.Info ?? 0}  `,
    `**Gaps:** ${tally('kind', ['missing', 'incorrect', 'weak'])}  `,
    `**Fix effort:** ${tally('effort', ['S', 'M', 'L'])}`,
  );
  if (exitCode === 3) lines.push('', `> ❗ ${EXIT_TEXT[3]}.`);
  if (errors.length) lines.push('', `> ⚠ The report has ${errors.length} format problem(s); numbers may be incomplete.`);

  if (findings.length) {
    lines.push('', '| ID | Severity | Kind | Location | Issue | Fix |', '|---|---|---|---|---|---|');
    for (const f of findings.slice(0, maxFindings)) {
      const loc = f.file ? `\`${cell(f.file, 80)}${Number.isInteger(f.line) ? `:${f.line}` : ''}\`` : '—';
      lines.push(`| ${cell(f.id, 20)} | ${cell(f.severity, 10)} | ${cell(f.kind, 10)} | ${loc} | ${cell(f.title)} | ${cell(f.fix, 220)} |`);
    }
    if (findings.length > maxFindings) lines.push('', `_…and ${findings.length - maxFindings} more in the full report._`);
  }

  const beforeRelease = section(section(reportText, '## 12. Fix plan', '## 13. Disclaimer'), '**Before release**', '**Next iteration**');
  if (beforeRelease) lines.push('', '<details><summary><b>Fix before release</b></summary>', '', beforeRelease, '', '</details>');

  let body = lines.join('\n') + footer;
  if (body.length > MAX_BODY) body = `${body.slice(0, MAX_BODY)}\n\n_(truncated)_${footer}`;
  return body;
}

async function upsertComment(body) {
  const { GITHUB_TOKEN: token, GITHUB_REPOSITORY: repo, GITHUB_EVENT_PATH: eventPath } = process.env;
  const api = process.env.GITHUB_API_URL || 'https://api.github.com';
  if (!token || !repo || !eventPath) throw new Error('GITHUB_TOKEN, GITHUB_REPOSITORY and GITHUB_EVENT_PATH are required to post');
  const pr = JSON.parse(fs.readFileSync(eventPath, 'utf8')).pull_request?.number;
  if (!pr) { console.log('not a pull_request event: comment not posted'); return; }
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  const list = await fetch(`${api}/repos/${repo}/issues/${pr}/comments?per_page=100`, { headers });
  if (!list.ok) throw new Error(`listing comments failed: HTTP ${list.status}`);
  const existing = (await list.json()).find(cm => typeof cm.body === 'string' && cm.body.startsWith(MARKER));
  const res = await fetch(existing ? `${api}/repos/${repo}/issues/comments/${existing.id}` : `${api}/repos/${repo}/issues/${pr}/comments`, {
    method: existing ? 'PATCH' : 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ body }),
  });
  if (!res.ok) throw new Error(`posting comment failed: HTTP ${res.status}`);
  console.log(`${existing ? 'updated' : 'posted'} audit comment on PR #${pr}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const file = argv.find(a => !a.startsWith('--') && argv[argv.indexOf(a) - 1] !== '--exit-code');
  const i = argv.indexOf('--exit-code');
  const exitCode = i >= 0 ? Number(argv[i + 1]) : null;
  const { GITHUB_SERVER_URL: server, GITHUB_REPOSITORY: repo, GITHUB_RUN_ID: run } = process.env;
  const runUrl = server && repo && run ? `${server}/${repo}/actions/runs/${run}` : null;
  const text = file && fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  const body = buildComment(text, { runUrl, exitCode });
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, body.replace(MARKER, '') + '\n');
  if (argv.includes('--post')) {
    try { await upsertComment(body); } catch (e) { console.error(`pr-comment: ${e.message}`); process.exit(1); }
  } else {
    console.log(body);
  }
}
