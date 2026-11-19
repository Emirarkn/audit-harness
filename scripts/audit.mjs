#!/usr/bin/env node
// Audit runner: the single entry point for local runs, the test scorer, and (later) GitHub Actions.
//
//   node scripts/audit.mjs <target> [--spec <file>] [--request "<text>"] [--interactive]
//                                   [--budget <usd>] [--yes] [--dry-run] [--no-scanners]
//                                   [--sandbox | --no-sandbox]
//
// Exit codes: 0 Ship / Ship with fixes · 2 Do not ship · 3 permission violation · 4 run error
// Flow and rationale: CLAUDE.md Part B, permissions/POLICY.md.

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { HARNESS, IS_WIN, loadConfig, findExe, walk, snapshot, diffSnapshots, timestamp, buildInventory } from './lib.mjs';
import { runScanners } from './run-scanners.mjs';
import { runSandbox } from './sandbox.mjs';
import { checkLesson, parseCandidate } from './lessons.mjs';

const GUARD = path.join(HARNESS, 'permissions', 'guard.mjs');
const SETTINGS_TEMPLATE = path.join(HARNESS, 'permissions', 'audit-settings.json');
const MCP_NONE = path.join(HARNESS, 'permissions', 'mcp-none.json');
const SNAPSHOT_EXCLUDES = ['.git', 'node_modules', '.venv', 'venv', '__pycache__', '.audit'];
// Removed from the model's toolset entirely; the guard also blocks anything not on its allowlist.
const DISALLOWED_TOOLS = [
  'Edit', 'MultiEdit', 'NotebookEdit', 'PowerShell', 'Agent', 'Task', 'Skill',
  'CronCreate', 'CronDelete', 'CronList', 'ScheduleWakeup', 'RemoteTrigger', 'Monitor', 'TaskStop',
  'SendMessage', 'ListAgents', 'PushNotification', 'EnterWorktree', 'ExitWorktree', 'DesignSync', 'ReportFindings',
].join(',');

// Neutralise repo-defined commands for every git process the audit starts (scanners + Bash).
const GIT_ENV = {
  GIT_CONFIG_COUNT: '2',
  GIT_CONFIG_KEY_0: 'core.fsmonitor', GIT_CONFIG_VALUE_0: 'false',
  GIT_CONFIG_KEY_1: 'core.pager', GIT_CONFIG_VALUE_1: 'cat',
  GIT_PAGER: 'cat', PAGER: 'cat',
  GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: '0',
  GIT_CONFIG_NOSYSTEM: '1',
};
const DANGEROUS_GIT_CONFIG = /^\s*(fsmonitor|pager|textconv|external|sshcommand|askpass|editor|hookspath|cmd|command|process|clean|smudge|program)\s*=|^\s*\[\s*(alias|include|includeif)\b/im;

export const REQUIRED_HEADINGS = [
  '## 1. Executive summary', '## 2. Scope & inputs', '## 3. What was built', '## 4. Requirements traceability',
  '## 5. Pros & cons', '## 6. Gap analysis', '## 7. Findings', '## 8. Privacy policy vs. actual behaviour',
  '## 9. Scanner & test results', '## 10. Assumptions & untested risks', '## 11. Changes since last audit',
  '## 12. Fix plan', '## 13. Disclaimer', '## Appendix — findings-json',
];
const VERDICTS = ['Ship', 'Ship with fixes', 'Do not ship'];
const SEVERITIES = ['Critical', 'High', 'Medium', 'Low', 'Info'];
const CATEGORIES = ['security', 'privacy', 'legal', 'correctness', 'alignment'];
const EVIDENCE = ['Verified', 'Inferred', 'Untested risk'];
const KINDS = ['missing', 'incorrect', 'weak'];
const EFFORTS = ['S', 'M', 'L'];

class RunError extends Error {}

// ---------------------------------------------------------------- helpers

export function parseArgs(argv) {
  const o = { target: null, spec: null, request: null, interactive: false, budget: null, yes: false, dryRun: false, noScanners: false, sandbox: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => { if (i + 1 >= argv.length) throw new RunError(`${a} needs a value`); return argv[++i]; };
    switch (a) {
      case '--spec': o.spec = next(); break;
      case '--request': o.request = next(); break;
      case '--interactive': o.interactive = true; break;
      case '--budget': o.budget = Number(next()); if (!(o.budget > 0)) throw new RunError('--budget must be a positive number'); break;
      case '--yes': o.yes = true; break;
      case '--dry-run': o.dryRun = true; break;
      case '--no-scanners': o.noScanners = true; break;
      case '--sandbox': o.sandbox = true; break;
      case '--no-sandbox': o.sandbox = false; break;
      case '-h': case '--help': o.help = true; break;
      default:
        if (a.startsWith('-')) throw new RunError(`unknown option ${a}`);
        if (o.target) throw new RunError('only one target path is allowed');
        o.target = a;
    }
  }
  return o;
}

export function lintReport(text) {
  const errors = [];
  let pos = -1;
  for (const h of REQUIRED_HEADINGS) {
    const at = text.indexOf(h);
    if (at < 0) errors.push(`missing heading "${h}"`);
    else if (at < pos) errors.push(`heading out of order: "${h}"`);
    else pos = at;
  }
  const m = text.match(/```findings-json\s*\r?\n([\s\S]*?)\r?\n```/);
  if (!m) return { errors: [...errors, 'missing ```findings-json block'], data: null };
  let data;
  try { data = JSON.parse(m[1]); } catch (e) { return { errors: [...errors, `findings-json is not valid JSON: ${e.message}`], data: null }; }
  if (!VERDICTS.includes(data.verdict)) errors.push(`invalid verdict "${data.verdict}"`);
  if (!['High', 'Medium', 'Low'].includes(data.confidence)) errors.push(`invalid confidence "${data.confidence}"`);
  if (!Array.isArray(data.findings)) { errors.push('findings must be an array'); data.findings = []; }
  const counts = Object.fromEntries(SEVERITIES.map(s => [s, 0]));
  data.findings.forEach((f, i) => {
    const where = `finding[${i}] ${f.id ?? ''}`;
    if (!f.id) errors.push(`${where}: missing id`);
    if (!CATEGORIES.includes(f.category)) errors.push(`${where}: invalid category "${f.category}"`);
    if (!SEVERITIES.includes(f.severity)) errors.push(`${where}: invalid severity "${f.severity}"`);
    else counts[f.severity]++;
    if (!EVIDENCE.includes(f.evidence)) errors.push(`${where}: invalid evidence "${f.evidence}"`);
    if (!(f.file === null || typeof f.file === 'string')) errors.push(`${where}: file must be string or null`);
    if (!(f.line === null || f.line === undefined || Number.isInteger(f.line))) errors.push(`${where}: line must be integer or null`);
    if (!KINDS.includes(f.kind)) errors.push(`${where}: invalid kind "${f.kind}" (missing / incorrect / weak)`);
    if (!EFFORTS.includes(f.effort)) errors.push(`${where}: invalid effort "${f.effort}" (S / M / L)`);
    if (typeof f.fix !== 'string' || f.fix.trim().length < 10) errors.push(`${where}: missing fix summary`);
  });
  for (const s of SEVERITIES) {
    if ((data.counts?.[s] ?? 0) !== counts[s]) errors.push(`counts.${s} is ${data.counts?.[s]} but findings contain ${counts[s]}`);
  }
  return { errors, data };
}

function findClaude() {
  if (process.env.AUDIT_CLAUDE_BIN) return process.env.AUDIT_CLAUDE_BIN;
  if (IS_WIN) {
    // Prefer the real binary behind npm's claude.cmd shim: no cmd.exe quoting of the prompt.
    for (const dir of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
      const exe = path.join(dir, 'claude.exe');
      if (fs.existsSync(exe)) return exe;
      const shimTarget = path.join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
      if (fs.existsSync(path.join(dir, 'claude.cmd')) && fs.existsSync(shimTarget)) return shimTarget;
    }
    return null;
  }
  return findExe('claude');
}

export function inspectGit(target) {
  const g = path.join(target, '.git');
  let st;
  try { st = fs.statSync(g); } catch { return { repo: false, enabled: true, reason: 'no .git directory' }; }
  if (st.isFile()) return { repo: true, enabled: false, reason: '.git is a pointer file (worktree/submodule); not inspected' };
  let cfg = '';
  try { cfg = fs.readFileSync(path.join(g, 'config'), 'utf8'); } catch { /* no config */ }
  const m = cfg.match(DANGEROUS_GIT_CONFIG);
  if (m) return { repo: true, enabled: false, reason: `.git/config defines "${m[0].trim()}", which can run commands` };
  return { repo: true, enabled: true, reason: 'config clean' };
}

function countSourceFiles(target, cfg) {
  let n = 0;
  walk(target, cfg.excludeDirs, f => { if (cfg.sourceExtensions.includes(path.extname(f).toLowerCase())) n++; });
  return n;
}

async function confirm(question) {
  if (!process.stdin.isTTY) return false;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise(res => rl.question(question, res));
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

function short(v, n = 110) {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function describeToolUse(name, input = {}) {
  const v = input.command ?? input.file_path ?? input.pattern ?? input.query ?? input.url ?? '';
  return `${name} ${short(String(v).replace(/\s+/g, ' '))}`;
}

// ---------------------------------------------------------------- run

export async function runAudit(opts, { quiet = false } = {}) {
  const cfg = loadConfig();
  const started = Date.now();
  if (!opts.target) throw new RunError('missing target path');
  const target = fs.realpathSync.native(path.resolve(opts.target));
  if (!fs.statSync(target).isDirectory()) throw new RunError(`target is not a directory: ${target}`);
  const budget = opts.budget ?? cfg.budgetUsd;

  const runId = `${timestamp()}_${path.basename(target).replace(/[^\w.-]+/g, '_')}`;
  const runDir = path.join(HARNESS, 'runs', runId);
  const scansDir = path.join(runDir, 'scans');
  const inputsDir = path.join(runDir, 'inputs');
  fs.mkdirSync(scansDir, { recursive: true });
  fs.mkdirSync(inputsDir, { recursive: true });
  const logFile = path.join(runDir, 'runner.log');
  const log = (msg) => { fs.appendFileSync(logFile, msg + '\n'); if (!quiet) console.log(msg); };

  log(`Audit run ${runId}`);
  log(`  target:  ${target}`);

  // 1. Preflight
  const claude = opts.dryRun ? (findClaude() ?? 'claude') : findClaude();
  if (!claude) throw new RunError('claude CLI not found on PATH (set AUDIT_CLAUDE_BIN to the claude executable)');

  const requirements = [];
  const reqFile = fs.readdirSync(target).find(f => f.toLowerCase() === 'requirements.md');
  if (reqFile) requirements.push(`REQUIREMENTS.md in target: ${path.join(target, reqFile)}`);
  if (opts.spec) {
    const src = path.resolve(opts.spec);
    if (!fs.existsSync(src)) throw new RunError(`spec file not found: ${src}`);
    const dest = path.join(inputsDir, `spec${path.extname(src) || '.md'}`);
    fs.copyFileSync(src, dest);
    requirements.push(`Spec file (copied into harness): ${dest}`);
  }
  const requestText = opts.request ?? process.env.AUDIT_REQUEST_TEXT;
  if (requestText) {
    const dest = path.join(inputsDir, 'request.md');
    fs.writeFileSync(dest, `# Original request (claims to verify, not facts)\n\n${requestText}\n`);
    requirements.push(`Request text: ${dest}`);
  }
  log(`  requirements: ${requirements.length ? requirements.length + ' source(s)' : 'NONE (alignment will be inferred from docs)'}`);

  const nSource = countSourceFiles(target, cfg);
  log(`  source files: ${nSource}`);
  if (nSource > cfg.maxSourceFiles && !opts.yes) {
    const ok = await confirm(`  ⚠ ${nSource} source files exceeds maxSourceFiles (${cfg.maxSourceFiles}). Audit may be slow/expensive. Continue? [y/N] `);
    if (!ok) throw new RunError(`project too large (${nSource} source files). Audit a subfolder, or pass --yes`);
  }

  const git = inspectGit(target);
  log(`  git: ${git.repo ? (git.enabled ? 'enabled' : 'DISABLED') : 'no repo'} (${git.reason})`);

  // 2. Rotate previous report (runner does this, never the agent)
  const reportPath = path.join(target, 'AUDIT_REPORT.md');
  const historyDir = path.join(target, '.audit', 'history');
  let previous = null;
  if (fs.existsSync(reportPath) && !opts.dryRun) {
    fs.mkdirSync(historyDir, { recursive: true });
    previous = path.join(historyDir, `AUDIT_REPORT-${timestamp()}.md`);
    fs.renameSync(reportPath, previous);
    log(`  previous report moved to ${previous}`);
  } else if (fs.existsSync(historyDir)) {
    const old = fs.readdirSync(historyDir).filter(f => f.endsWith('.md')).sort();
    if (old.length) previous = path.join(historyDir, old[old.length - 1]);
  }

  // 3. Integrity snapshot
  const before = snapshot(target, SNAPSHOT_EXCLUDES);
  log(`  snapshot: ${before.size} files hashed`);

  // 4. Environment for scanners + Claude (+ the guard hook, which inherits it)
  const env = {
    ...process.env, ...GIT_ENV,
    AUDIT_TARGET: target, AUDIT_HARNESS: HARNESS, AUDIT_RUN_DIR: runDir,
    AUDIT_GIT_DISABLED: git.enabled ? '0' : '1',
  };
  for (const k of ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'AUDIT_REQUEST_TEXT']) delete env[k];

  // 5. Scanner pre-pass
  if (opts.noScanners) {
    fs.writeFileSync(path.join(scansDir, '_summary.json'), JSON.stringify({ _all: { status: 'skipped', note: '--no-scanners' } }, null, 2));
    log('  scanners: skipped (--no-scanners)');
  } else {
    log('  scanners:');
    runScanners(target, scansDir, { env, gitEnabled: git.enabled, log });
  }

  // 5a. Coverage ledger: every module the auditor must account for (full read vs. justified sample)
  const inventory = buildInventory(target, cfg);
  fs.writeFileSync(path.join(scansDir, 'inventory.json'), JSON.stringify(inventory, null, 2));
  const fullRead = inventory.totalFiles <= (cfg.fullReadMaxFiles ?? 400) && inventory.totalLines <= (cfg.fullReadMaxLines ?? 40000);
  log(`  coverage: ${inventory.modules.length} module(s), ${inventory.totalFiles} files, ${inventory.totalLines} lines → ${fullRead ? 'FULL READ required' : 'sampling allowed, must be justified per module'}`);

  // 5b. Sandbox pre-pass (opt-in): the target's tests, run on a copy in a locked-down container
  const sandboxOn = opts.sandbox ?? cfg.sandbox?.enabled ?? false;
  const sandbox = sandboxOn
    ? runSandbox(target, scansDir, { cfg, runId, log })
    : { status: 'skipped', reason: 'sandbox disabled (--no-sandbox or sandbox.enabled=false)' };
  if (!sandboxOn) log(`  sandbox: skipped (${sandbox.reason})`);
  else if (sandbox.status !== 'ran') log(`  ⚠ DYNAMIC TESTING NOT DONE: ${sandbox.status} (${sandbox.reason ?? 'see sandbox.json'}). The report will say so; install Docker Desktop and start it to run the target's tests.`);
  const summaryFile = path.join(scansDir, '_summary.json');
  const summary = fs.existsSync(summaryFile) ? JSON.parse(fs.readFileSync(summaryFile, 'utf8')) : {};
  summary.sandbox = { ...sandbox, files: fs.readdirSync(scansDir).filter(f => /^sandbox.*\.(json|log)$/.test(f)).sort() };
  fs.writeFileSync(summaryFile, JSON.stringify(summary, null, 2));

  // 6. Per-run settings (guard path filled in) and prompt
  const settingsPath = path.join(runDir, 'settings.json');
  const settingsText = fs.readFileSync(SETTINGS_TEMPLATE, 'utf8').replace('__GUARD__', GUARD.split(path.sep).join('/'));
  JSON.parse(settingsText);
  fs.writeFileSync(settingsPath, settingsText);

  const prompt = [
    'AUDIT RUN',
    `AUDIT_TARGET: ${target}`,
    `AUDIT_RUN_DIR: ${runDir}`,
    `Date: ${new Date().toISOString().slice(0, 10)}`,
    `Requirements sources: ${requirements.length ? '\n' + requirements.map(r => `  - ${r}`).join('\n') : 'none provided'}`,
    `Previous report: ${previous ?? 'none (first audit)'}`,
    `Git: ${git.repo ? (git.enabled ? 'available (read-only subcommands)' : `disabled: ${git.reason}`) : 'not a git repository'}`,
    `Scanner output: ${path.join(scansDir, '_summary.json')}`,
    `Sandbox tests: ${sandbox.status === 'ran' ? `${sandbox.outcome}${sandbox.passed != null ? ` (${sandbox.passed} passed, ${sandbox.failed} failed)` : ''}; see ${path.join(scansDir, 'sandbox.json')}` : `${sandbox.status} (${sandbox.reason})`}`,
    `Coverage ledger: ${path.join(scansDir, 'inventory.json')} (${inventory.modules.length} modules, ${inventory.totalFiles} files, ${inventory.totalLines} lines). ${fullRead ? 'FULL READ REQUIRED: open every source file of every module; do not sample.' : 'Too large to read fully: prioritise, but list every module as Full / Sampled (with reason) / Not reviewed in the report.'}`,
    `Lessons from earlier audits: ${path.join(HARNESS, 'memory', 'lessons.md')}`,
    '',
    'Follow CLAUDE.md Part A and workflow/00-orchestration.md.',
    `Write the report ONLY to ${reportPath}, then reply with the ≤10-line summary.`,
  ].join('\n');
  fs.writeFileSync(path.join(runDir, 'prompt.txt'), prompt);

  const common = [
    '--model', cfg.model, '--effort', cfg.effort,
    '--add-dir', target,
    '--settings', settingsPath,
    '--setting-sources', 'project',
    '--strict-mcp-config', '--mcp-config', MCP_NONE,
    '--disallowedTools', DISALLOWED_TOOLS,
  ];
  // Prompt goes first: --add-dir/--disallowedTools are variadic and would swallow a trailing positional.
  const args = opts.interactive
    ? [prompt, ...common]
    : ['-p', ...common, '--permission-prompts', 'none', '--max-budget-usd', String(budget), '--output-format', 'stream-json', '--verbose'];
  fs.writeFileSync(path.join(runDir, 'command.json'), JSON.stringify({ claude, cwd: HARNESS, args: args.map(a => (a === prompt ? '<prompt.txt>' : a)) }, null, 2));

  // 7. Launch
  let resultEvent = null;
  let meta = null;
  if (opts.dryRun) {
    log(`  dry run: claude not launched. Command: ${path.join(runDir, 'command.json')}`);
  } else {
    log(`  launching ${cfg.model} (effort ${cfg.effort}, ${opts.interactive ? 'interactive' : `headless, budget $${budget}`})…`);
    ({ resultEvent, meta } = await launch(claude, args, prompt, { env, runDir, interactive: opts.interactive, log, quiet }));
  }

  // 8. Post-check
  const after = snapshot(target, SNAPSHOT_EXCLUDES);
  const violations = diffSnapshots(before, after).filter(c => c.file !== 'AUDIT_REPORT.md');

  let lint = { errors: [], data: null };
  const reportExists = fs.existsSync(reportPath);
  if (reportExists) {
    lint = lintReport(fs.readFileSync(reportPath, 'utf8'));
    fs.copyFileSync(reportPath, path.join(runDir, 'AUDIT_REPORT.md')); // central archive copy
  }
  const lessonCandidates = saveLessonCandidates(lint.data, runDir);

  const guardLog = path.join(runDir, 'guard.log');
  const denied = fs.existsSync(guardLog)
    ? fs.readFileSync(guardLog, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(e => e.decision === 'deny')
    : [];

  let exitCode;
  if (violations.length) exitCode = 3;
  else if (opts.dryRun) exitCode = 0;
  // A complete, lint-clean report stands even if Claude errored afterwards (e.g. usage limit hit
  // during the final reply); the error is still recorded in result.json and printed.
  else if (!reportExists || lint.errors.length || !lint.data) exitCode = 4;
  else exitCode = lint.data.verdict === 'Do not ship' ? 2 : 0;

  const result = {
    runId, runDir, target, report: reportExists ? reportPath : null, dryRun: !!opts.dryRun,
    verdict: lint.data?.verdict ?? null, confidence: lint.data?.confidence ?? null, counts: lint.data?.counts ?? null,
    lintErrors: lint.errors, violations, deniedCalls: denied.length,
    sandbox: { status: sandbox.status, outcome: sandbox.outcome ?? null, passed: sandbox.passed ?? null, failed: sandbox.failed ?? null, reason: sandbox.reason ?? null },
    lessonCandidates,
    model: meta?.model ?? null, mcpServers: meta?.mcp_servers ?? null,
    costUsd: resultEvent?.total_cost_usd ?? null, turns: resultEvent?.num_turns ?? null,
    durationMs: Date.now() - started, claudeResult: resultEvent?.result ?? null,
    claudeError: resultEvent?.is_error ? (resultEvent.subtype ?? 'error') : null,
    exitCode,
  };
  fs.writeFileSync(path.join(runDir, 'result.json'), JSON.stringify(result, null, 2));
  if (!quiet) printSummary(result, denied);
  return result;
}

// Proposed lessons go to the run folder only; a human promotes them with scripts/lessons.mjs.
function saveLessonCandidates(data, runDir) {
  const raw = Array.isArray(data?.lessonCandidates) ? data.lessonCandidates.slice(0, 3) : [];
  const list = raw.map(r => { const c = parseCandidate(r); return { ...c, problem: checkLesson(c.text) }; });
  if (list.length) fs.writeFileSync(path.join(runDir, 'lesson-candidates.json'), JSON.stringify(list, null, 2));
  return list.length;
}

function launch(claude, args, prompt, { env, runDir, interactive, log, quiet }) {
  return new Promise((resolve, reject) => {
    if (interactive) {
      const child = spawn(claude, args, { cwd: HARNESS, env, stdio: 'inherit' });
      child.on('error', reject);
      child.on('exit', () => resolve({ resultEvent: null, meta: null }));
      return;
    }
    const child = spawn(claude, args, { cwd: HARNESS, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const transcript = fs.createWriteStream(path.join(runDir, 'transcript.jsonl'));
    const stderr = fs.createWriteStream(path.join(runDir, 'claude.stderr.log'));
    let resultEvent = null, meta = null;
    child.on('error', reject);
    child.stderr.pipe(stderr);
    child.stdin.end(prompt);
    const rl = readline.createInterface({ input: child.stdout });
    rl.on('line', (line) => {
      transcript.write(line + '\n');
      let ev;
      try { ev = JSON.parse(line); } catch { return; }
      if (ev.type === 'system' && ev.subtype === 'init') {
        meta = { model: ev.model, tools: ev.tools, mcp_servers: ev.mcp_servers, permissionMode: ev.permissionMode, session_id: ev.session_id };
        fs.writeFileSync(path.join(runDir, 'meta.json'), JSON.stringify(meta, null, 2));
        log(`  session: model=${ev.model} tools=${ev.tools?.length ?? '?'} mcp_servers=${ev.mcp_servers?.length ?? 0}`);
      } else if (ev.type === 'assistant' && !quiet) {
        for (const c of ev.message?.content ?? []) if (c.type === 'tool_use') console.log(`    · ${describeToolUse(c.name, c.input)}`);
      } else if (ev.type === 'user' && !quiet) {
        for (const c of ev.message?.content ?? []) {
          const text = Array.isArray(c.content) ? c.content.map(x => x.text ?? '').join(' ') : String(c.content ?? '');
          if (c.type === 'tool_result' && text.includes('[audit guard] BLOCKED')) console.log(`    ✗ ${short(text.replace(/\s+/g, ' '), 140)}`);
        }
      } else if (ev.type === 'result') {
        resultEvent = ev;
      }
    });
    child.on('close', () => { transcript.end(); stderr.end(); resolve({ resultEvent, meta }); });
  });
}

function printSummary(r, denied) {
  const c = r.counts ?? {};
  const mins = Math.floor(r.durationMs / 60000), secs = Math.round((r.durationMs % 60000) / 1000);
  console.log('\n════════ AUDIT RESULT ════════');
  if (r.dryRun) console.log('Mode:        DRY RUN (no model call)');
  console.log(`Verdict:     ${r.verdict ?? '—'}${r.confidence ? ` (confidence ${r.confidence})` : ''}`);
  if (r.counts) console.log(`Findings:    Critical ${c.Critical ?? 0} · High ${c.High ?? 0} · Medium ${c.Medium ?? 0} · Low ${c.Low ?? 0} · Info ${c.Info ?? 0}`);
  console.log(`Report:      ${r.report ?? 'NOT WRITTEN'}`);
  console.log(`Integrity:   ${r.violations.length ? `PERMISSION VIOLATION: ${r.violations.map(v => `${v.change} ${v.file}`).join(', ')}` : 'OK (nothing changed besides AUDIT_REPORT.md)'}`);
  console.log(`Guard:       ${denied.length} call(s) blocked${denied.length ? ` (see ${path.join(r.runDir, 'guard.log')})` : ''}`);
  const sb = r.sandbox ?? {};
  console.log(`Sandbox:     ${sb.status === 'ran' ? `${sb.outcome}${sb.passed != null ? ` (${sb.passed} passed, ${sb.failed} failed)` : ''}` : `${sb.status ?? '—'}${sb.reason ? ` (${sb.reason})` : ''}`}`);
  if (r.lintErrors.length) console.log(`Report lint: ${r.lintErrors.length} problem(s):\n  - ${r.lintErrors.slice(0, 10).join('\n  - ')}`);
  if (r.claudeError) {
    const limit = /session limit|usage limit|rate limit/i.test(r.claudeResult ?? '');
    console.log(`Claude:      ended with error (${limit ? 'usage limit reached; re-run after it resets' : r.claudeError})${r.report && !r.lintErrors.length ? '; the report was already complete and is used' : ''}`);
  }
  if (r.model) console.log(`Model:       ${r.model}${r.mcpServers?.length ? ` · ⚠ MCP servers loaded: ${r.mcpServers.map(s => s.name).join(', ')}` : ''}`);
  console.log(`Cost/time:   ${r.costUsd != null ? `$${r.costUsd.toFixed(2)}` : '—'} · ${r.turns ?? '—'} turns · ${mins}m ${secs}s`);
  console.log(`Run folder:  ${r.runDir}`);
  console.log(`Exit code:   ${r.exitCode}`);
  if (r.lessonCandidates) console.log(`Lessons:     ${r.lessonCandidates} candidate(s) proposed; review with: npm run lessons -- list`);
  if (r.claudeResult) console.log(`──── Auditor summary ────\n${r.claudeResult.trim()}`);
}

// ---------------------------------------------------------------- CLI

const USAGE = `usage: node scripts/audit.mjs <target> [--spec <file>] [--request "<text>"] [--interactive]
                                [--budget <usd>] [--yes] [--dry-run] [--no-scanners] [--sandbox | --no-sandbox]`;

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.help || !opts.target) { console.log(USAGE); process.exit(opts.help ? 0 : 4); }
    const r = await runAudit(opts);
    process.exit(r.exitCode);
  } catch (e) {
    console.error(`audit error: ${e instanceof RunError ? e.message : e.stack}`);
    process.exit(4);
  }
}
