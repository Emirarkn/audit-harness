// GitHub PR comment builder. Free: no network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildComment, MARKER } from '../scripts/pr-comment.mjs';
import { REQUIRED_HEADINGS } from '../scripts/audit.mjs';

function report(json, fixPlan = '**Before release**\n1. Parameterise queries — SEC-001 · S\n\n**Next iteration**\n1. Later stuff') {
  const body = REQUIRED_HEADINGS.filter(h => !h.startsWith('## Appendix')).map(h => `${h}\n\n${h.startsWith('## 12.') ? fixPlan : 'text'}\n`).join('\n');
  return `# Audit Report — x\n\n${body}\n## Appendix — findings-json\n\`\`\`findings-json\n${JSON.stringify(json)}\n\`\`\`\n`;
}

const data = {
  verdict: 'Do not ship', confidence: 'High',
  counts: { Critical: 1, High: 0, Medium: 0, Low: 1, Info: 0 },
  requirements: [],
  findings: [
    { id: 'COR-001', category: 'correctness', severity: 'Low', evidence: 'Verified', kind: 'weak', effort: 'M', file: 'a.py', line: 3, title: 'Weak | pipe', fix: 'Handle the empty list case in a.py' },
    { id: 'SEC-001', category: 'security', severity: 'Critical', evidence: 'Verified', kind: 'incorrect', effort: 'S', file: 'src/db.js', line: 7, title: 'SQL injection', fix: 'Use parameterised queries' },
  ],
};

test('comment has marker, verdict, tallies, findings sorted by severity, and the before-release plan', () => {
  const c = buildComment(report(data), { runUrl: 'https://github.com/o/r/actions/runs/1' });
  assert.ok(c.startsWith(MARKER));
  assert.match(c, /❌ Do not ship \(confidence High\)/);
  assert.match(c, /\*\*Gaps:\*\* missing 0 · incorrect 1 · weak 1/);
  assert.ok(c.indexOf('SEC-001') < c.indexOf('COR-001'), 'Critical first');
  assert.match(c, /Weak \\\| pipe/, 'pipes escaped in table cells');
  assert.match(c, /Parameterise queries — SEC-001/);
  assert.ok(!c.includes('Later stuff'), 'only the before-release tier');
  assert.match(c, /actions\/runs\/1/);
});

test('no report: explains the exit code', () => {
  assert.match(buildComment(null, { exitCode: 3 }), /permission violation/);
  assert.match(buildComment(null, { exitCode: 4 }), /run error/);
});

test('unparsable report is reported, not crashed on', () => {
  assert.match(buildComment('# nothing here'), /unreadable report/);
});

test('long comments are truncated under the GitHub limit', () => {
  const many = { ...data, findings: Array.from({ length: 400 }, (_, i) => ({ ...data.findings[1], id: `SEC-${i}`, title: 'x'.repeat(150), fix: 'y'.repeat(200) })) };
  many.counts = { ...data.counts, Critical: 400, Low: 0 };
  const c = buildComment(report(many, 'x'.repeat(70000)), { maxFindings: 400 });
  assert.ok(c.length <= 61000);
});
