#!/usr/bin/env node
// Lessons memory: the auditor proposes generic lessons (findings-json `lessonCandidates`), the
// runner saves them per run, and a human reviews them here. Only accepted lessons reach
// memory/lessons.md, which every audit reads. The auditor itself can never write that file.
//
//   node scripts/lessons.mjs list
//   node scripts/lessons.mjs accept <key> [--category <c>] [--text "<edited text>"]
//   node scripts/lessons.mjs reject <key>
//   node scripts/lessons.mjs add "<text>" --category <c>

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HARNESS } from './lib.mjs';
import { SECRET_PATTERNS, PII_PATTERNS } from '../permissions/guard.mjs';

export const LESSON_CATEGORIES = ['security', 'privacy', 'legal', 'correctness', 'alignment', 'process'];
const MAX_LESSONS = 50;

export function paths(root = HARNESS) {
  return {
    lessons: path.join(root, 'memory', 'lessons.md'),
    review: path.join(root, 'memory', 'lessons-review.json'),
    runs: path.join(root, 'runs'),
  };
}

// "[legal] Check X" → { category: 'legal', text: 'Check X' }
export function parseCandidate(raw) {
  const s = String(raw ?? '').trim();
  const m = s.match(/^\[(\w+)\]\s*(.*)$/s);
  if (m && LESSON_CATEGORIES.includes(m[1].toLowerCase())) return { category: m[1].toLowerCase(), text: m[2].trim() };
  return { category: null, text: s };
}

// A lesson must be generic: no secrets, personal data, file paths, or multi-line code.
export function checkLesson(text) {
  if (typeof text !== 'string') return 'not a string';
  if (text.length < 15) return 'too short';
  if (text.length > 300) return 'longer than 300 characters';
  if (/[\r\n]/.test(text)) return 'contains a line break';
  for (const [re, label] of SECRET_PATTERNS) if (re.test(text)) return `contains a secret (${label})`;
  for (const [re, label] of PII_PATTERNS) if (re.test(text)) return `contains personal data (${label})`;
  if (/[A-Za-z]:\\|(?:^|\s)\/(?:home|users|tmp|var|etc)\//i.test(text)) return 'contains an absolute path';
  if (/\b[\w-]+\/[\w./-]+\.(?:js|mjs|ts|py|json|md|html|ya?ml|env|sql)\b/i.test(text)) return 'contains a project file path';
  return null;
}

const norm = s => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

export function readLessons(file) {
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const lessons = [...text.matchAll(/^- \*\*(L-\d+)\*\* \[(\w+)\] (.+)$/gm)].map(m => ({ id: m[1], category: m[2], text: m[3] }));
  return { text, lessons };
}

export function appendLesson(file, text, category) {
  const err = checkLesson(text);
  if (err) throw new Error(`lesson rejected: ${err}`);
  if (!LESSON_CATEGORIES.includes(category)) throw new Error(`category must be one of: ${LESSON_CATEGORIES.join(', ')}`);
  const { text: doc, lessons } = readLessons(file);
  if (lessons.some(l => norm(l.text) === norm(text))) throw new Error('an identical lesson already exists');
  const next = 1 + Math.max(0, ...lessons.map(l => Number(l.id.slice(2))));
  const id = `L-${String(next).padStart(3, '0')}`;
  const line = `- **${id}** [${category}] ${text}`;
  fs.writeFileSync(file, doc.replace(/\s*$/, '') + '\n' + line + '\n');
  if (lessons.length + 1 > MAX_LESSONS) console.warn(`⚠ ${lessons.length + 1} lessons: consider retiring old ones (the auditor reads them all every run).`);
  return id;
}

function readReview(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}

// Pending candidates from all archived runs, minus reviewed ones and ones already in lessons.md.
export function pendingCandidates(p = paths()) {
  const review = readReview(p.review);
  const known = new Set(readLessons(p.lessons).lessons.map(l => norm(l.text)));
  const out = [];
  const seen = new Set();
  if (!fs.existsSync(p.runs)) return out;
  for (const run of fs.readdirSync(p.runs).sort()) {
    const f = path.join(p.runs, run, 'lesson-candidates.json');
    if (!fs.existsSync(f)) continue;
    let list;
    try { list = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { continue; }
    list.forEach((c, i) => {
      const key = `${run}#${i}`;
      const n = norm(c.text ?? '');
      if (review[key] || known.has(n) || seen.has(n)) return;
      seen.add(n);
      out.push({ key, ...c });
    });
  }
  return out;
}

function decide(p, key, status, extra = {}) {
  const review = readReview(p.review);
  review[key] = { status, date: new Date().toISOString().slice(0, 10), ...extra };
  fs.writeFileSync(p.review, JSON.stringify(review, null, 2) + '\n');
}

// ---------------------------------------------------------------- CLI

function main(argv) {
  const p = paths();
  const [cmd, ...rest] = argv;
  const flag = (name) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : undefined; };
  const positional = rest.filter((a, i) => !a.startsWith('--') && !(i > 0 && rest[i - 1].startsWith('--')));

  if (cmd === 'list' || !cmd) {
    const pending = pendingCandidates(p);
    if (!pending.length) { console.log('No pending lesson candidates.'); return 0; }
    for (const c of pending) {
      console.log(`${c.key}\n  [${c.category ?? '?'}] ${c.text}${c.problem ? `\n  ⚠ cannot be accepted as is: ${c.problem}` : ''}\n`);
    }
    console.log('Accept: npm run lessons -- accept <key> [--category c] [--text "edited"]   Reject: npm run lessons -- reject <key>');
    return 0;
  }
  if (cmd === 'accept') {
    const key = positional[0];
    const c = pendingCandidates(p).find(x => x.key === key);
    if (!c) { console.error(`no pending candidate ${key}`); return 1; }
    const id = appendLesson(p.lessons, flag('--text') ?? c.text, flag('--category') ?? c.category ?? 'process');
    decide(p, key, 'accepted', { lesson: id });
    console.log(`Added ${id} to memory/lessons.md`);
    return 0;
  }
  if (cmd === 'reject') {
    const key = positional[0];
    if (!pendingCandidates(p).some(x => x.key === key)) { console.error(`no pending candidate ${key}`); return 1; }
    decide(p, key, 'rejected');
    console.log(`Rejected ${key}`);
    return 0;
  }
  if (cmd === 'add') {
    const id = appendLesson(p.lessons, positional[0], flag('--category') ?? 'process');
    console.log(`Added ${id} to memory/lessons.md`);
    return 0;
  }
  console.error('usage: node scripts/lessons.mjs list | accept <key> [--category c] [--text "..."] | reject <key> | add "<text>" --category c');
  return 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exit(main(process.argv.slice(2))); } catch (e) { console.error(e.message); process.exit(1); }
}
