# Permission Policy: Audit Runs

This is the human-readable spec. `guard.mjs` enforces it, and `tests/guard.test.mjs` proves it.
Change all three together.

## Principle
The auditor may **look at everything in the target and the harness, change nothing except
`AUDIT_REPORT.md`, run nothing from the target, and reveal nothing private to the internet.**

## Layers (defense in depth)
| # | Layer | Where | What it stops |
|---|---|---|---|
| 1 | Session isolation | `scripts/audit.mjs` flags | `--setting-sources project` keeps your user settings, plugins and hooks out. `--strict-mcp-config` with `mcp-none.json` means no connectors (Supabase, Vercel, Drive…). `--permission-prompts none` auto-denies anything that would need approval. |
| 2 | Settings rules + toolset | `audit-settings.json`, `--disallowedTools` in `audit.mjs` | Tool-level allow/deny. Edit, NotebookEdit, Agent, PowerShell and Skill are denied, and scheduling, remote, messaging and worktree tools are removed from the model's toolset entirely. |
| 3 | Guard hook | `guard.mjs` (PreToolUse, all tools) | Checks the arguments of every call (paths, commands, URLs, report content). Fails closed. |
| 4 | Git hardening | `scripts/audit.mjs` | Neutralises repo-defined commands (`core.fsmonitor`, `core.pager`, `diff.external`) through `GIT_CONFIG_*` env overrides. If the target's `.git/config` defines command-running keys, git is disabled for the run. |
| 5 | Integrity check | `scripts/audit.mjs` | Hashes the target before and after the run. Any change except `AUDIT_REPORT.md` is a **PERMISSION VIOLATION** (exit code 3). |
| 6 | Sandbox (opt-in) | `scripts/sandbox.mjs` | The only place the target's code ever runs. Done by the runner before the model starts, in a throwaway container on a copy. See "Sandbox" below. |

## Rules enforced by the guard
### Tools
| Tool | Rule |
|---|---|
| Read, Glob, Grep | Only inside **AUDIT_TARGET** or the **harness**. Symlinks and junctions are resolved first. Everything else is blocked (`~/.ssh`, `~/.claude/.credentials.json`, other projects, system files). |
| Write | Only to exactly `<AUDIT_TARGET>/AUDIT_REPORT.md`. The content is blocked if it contains an unredacted secret (AWS/Stripe/GitHub/Slack/Google keys, `sk-…` keys, private keys, JWTs). |
| Bash | Read-only allowlist (below). Each `|`, `&&`, `||`, `;` segment is checked separately. |
| WebSearch | ≤ 200 characters. No code characters `{ } ; < > \``. No token ≥ 60 characters. No secrets. No PII (emails, 11-digit T.C. numbers, Turkish phone numbers). |
| WebFetch | http(s) only. No localhost or private/link-local addresses. ≤ 500 characters. No secrets or PII in the URL. |
| TodoWrite, ToolSearch | Allowed (they don't touch anything outside the session). |
| Anything else | Blocked: Edit, NotebookEdit, PowerShell, Agent/Task, Skill, all `mcp__*`, scheduling and remote tools. |

### Bash allowlist
- `git` with read-only subcommands only: `log show diff status ls-files ls-tree blame rev-parse rev-list shortlog cat-file grep describe`.
  - Allowed before the subcommand: `-C <path in roots>` and `--no-pager`.
  - Blocked anywhere: `--output*`, `--ext-diff`, `--textconv`, `--filters`, `-O`/`--open-files-in-pager`.
- `ls cat head tail wc stat file du tree realpath basename dirname`: path arguments must be in the roots.
- `grep`/`egrep`/`fgrep`: the pattern is free text; paths and `-f` files must be in the roots.
- `find`: starting points must be in the roots. `-exec -execdir -ok -okdir -delete -fprint* -fls` are blocked.
- `sort` (no `-o`), `uniq` (no output file), `tree` (no `-o`), `cut`, `tr`, `echo`, `pwd`.
- `cd <dir in roots>`.

**Blocked everywhere in Bash:**
- `$` and backticks, except inside single quotes
- `> >> < ( ) { }` and background `&`
- inline `VAR=value`
- calling a command by path
- unbalanced quotes

`2>/dev/null`, `>/dev/null` and `2>&1` are the only redirections allowed.

## Sandbox (`--sandbox`, runner only)
The auditor never runs code. With `--sandbox`, the runner runs the target's own test suite before
the model starts, and the model reads the results from `scans/`:

| Control | Setting |
|---|---|
| What is mounted | A fresh **copy** of the target (excluded dirs left out) at `/work`. The original is never mounted. |
| Environment | No host env vars. Only `HOME`, `CI`, cache paths, and output flags are set, so `ANTHROPIC_API_KEY` and other secrets never reach the container. |
| User and privileges | Non-root user, `--cap-drop ALL`, `--security-opt no-new-privileges`. |
| Resources | `--memory 2g`, `--cpus 2`, `--pids-limit 512`, hard timeouts (install 10 min, tests 10 min). The container is killed on timeout and always removed (`--rm`). |
| Network | Install phase: network allowed for package downloads (`installNetwork: false` turns it off), npm lifecycle scripts disabled (`--ignore-scripts`). **Test phase: `--network none`, always.** |
| Commands | Fixed templates only (`npm ci/install`, `npm test`, `pip install -r requirements*.txt`, `pytest` / `unittest`). Target file names are used only if they match `requirements[\w.-]*.txt`. |

Residual risk: `npm test` and the test files are the target's own code, so they can do anything
*inside* the container. A container escape would need a Docker or kernel vulnerability. Python
packages built from source can run code during the install phase, which has network access. Use
`installNetwork: false` with pre-vendored dependencies for untrusted projects.

## Lessons memory
`memory/lessons.md` is read by every audit and **written only by a human** through
`scripts/lessons.mjs`. The auditor proposes candidates in the report's JSON; the runner saves
them to `runs/<id>/lesson-candidates.json` after checking them for secrets, personal data and
paths. The guard's Write rule (report file only) keeps the auditor from editing its own memory.

## GitHub Actions (`ci/github/project-audit.yml`)
- Job permissions: `contents: read`, `pull-requests: write` (sticky comment only).
- Runs on manual dispatch or on PRs labelled `audit`, never on fork PRs. Uses `pull_request`,
  never `pull_request_target`.
- `ANTHROPIC_API_KEY` is passed only to the audit step. User input (`request`) goes through an env
  var, never into the shell script inline.
- Uploaded artifacts leave out `transcript.jsonl`, because it can contain file contents the auditor read.

## Fail-closed behaviour
- `AUDIT_TARGET` unset, unparsable hook input, or an exception: the call is **blocked**.
- If `node` itself is missing, the hook cannot run. Claude Code treats a hook that fails to start
  as non-blocking, which is why layers 1, 2 and 5 exist. The runner checks that `node` is
  available before it launches.

## Logging
Every decision is appended to `runs/<run-id>/guard.log` as JSON lines:
`{ts, tool, decision, reason, input}`.
Blocked attempts are summarized in the runner's final output.

## Known limits
- Shell parsing is conservative and might block an unusual but harmless command. The auditor is
  told to work around blocks with other allowed tools, not to fight them.
- Reading `.env` and secrets inside the target is **allowed**, because the audit needs it. Secrets
  reach the model's context. Redaction is enforced only at the report boundary.
- Scanners run in the runner, outside the guard: they are trusted tools with fixed arguments.
