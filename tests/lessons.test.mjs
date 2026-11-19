// Lessons memory: candidate sanitising, review flow, and the seeded lessons file. Free.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkLesson, parseCandidate, readLessons, appendLesson, pendingCandidates, paths, LESSON_CATEGORIES } from '../scripts/lessons.mjs';

function sandboxRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lessons-'));
  fs.mkdirSync(path.join(root, 'memory'));
  fs.writeFileSync(path.join(root, 'memory', 'lessons.md'), '# Audit lessons\n\n## Lessons\n- **L-001** [security] Check that upload size limits are enforced on the server side.\n');
  return root;
}

test('parseCandidate reads the [category] prefix', () => {
  assert.deepEqual(parseCandidate('[legal] Check cookie banners'), { category: 'legal', text: 'Check cookie banners' });
  assert.deepEqual(parseCandidate('[nonsense] x y z'), { category: null, text: '[nonsense] x y z' });
});

test('checkLesson rejects secrets, personal data, paths and multi-line text', () => {
  assert.equal(checkLesson('Check that consent defaults are false on the server side too.'), null);
  assert.match(checkLesson('Keys like AKIAABCDEFGHIJKLMNOP are often committed by mistake'), /secret/);
  assert.match(checkLesson('Contact ali.veli@example.com when audits fail on this kind of app'), /personal data/);
  assert.match(checkLesson('Always check src/routes/admin.js for missing auth middleware'), /file path/);
  assert.match(checkLesson('Look in C:\\Users\\someone\\project for leftover dumps'), /path/);
  assert.match(checkLesson('first line of the lesson\nsecond line'), /line break/);
  assert.match(checkLesson('short'), /short/);
});

test('appendLesson numbers lessons and refuses duplicates', () => {
  const p = paths(sandboxRoot());
  assert.equal(appendLesson(p.lessons, 'Compare documented retention periods with actual deletion jobs.', 'privacy'), 'L-002');
  assert.equal(readLessons(p.lessons).lessons.length, 2);
  assert.throws(() => appendLesson(p.lessons, 'Compare documented retention periods with actual deletion jobs.', 'privacy'), /identical/);
  assert.throws(() => appendLesson(p.lessons, 'A perfectly fine lesson text here.', 'misc'), /category/);
});

test('pendingCandidates skips reviewed, known and duplicate candidates', () => {
  const root = sandboxRoot();
  const p = paths(root);
  const add = (run, list) => { fs.mkdirSync(path.join(p.runs, run), { recursive: true }); fs.writeFileSync(path.join(p.runs, run, 'lesson-candidates.json'), JSON.stringify(list)); };
  add('r1', [{ category: 'legal', text: 'Check the cookie banner blocks analytics until consent.' }, { category: 'security', text: 'Check that upload size limits are enforced on the server side.' }]);
  add('r2', [{ category: 'legal', text: 'Check the cookie banner blocks analytics until consent.' }]);
  const pending = pendingCandidates(p);
  assert.deepEqual(pending.map(c => c.key), ['r1#0']);
  fs.writeFileSync(p.review, JSON.stringify({ 'r1#0': { status: 'rejected' } }));
  assert.deepEqual(pendingCandidates(p).map(c => c.key), ['r2#0']);
});

test('the shipped lessons file is well-formed and clean', () => {
  const { lessons } = readLessons(paths().lessons);
  assert.ok(lessons.length >= 1);
  const ids = lessons.map(l => l.id);
  assert.equal(new Set(ids).size, ids.length, 'unique ids');
  for (const l of lessons) {
    assert.ok(LESSON_CATEGORIES.includes(l.category), `${l.id} category`);
    assert.equal(checkLesson(l.text), null, `${l.id}: ${checkLesson(l.text)}`);
  }
});
