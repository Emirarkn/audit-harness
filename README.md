<p align="center">
  <img src="docs/banner.png" alt="Audits Agent: an auditor checking a checklist through a magnifying glass" width="420">
</p>

# Audit Harness

[![Harness tests](https://github.com/Emirarkn/audit-harness/actions/workflows/harness-tests.yml/badge.svg)](https://github.com/Emirarkn/audit-harness/actions/workflows/harness-tests.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

An independent, final-stage auditor for your projects. Run it when a project is done: it reviews
the actual code (not the builder's claims) and writes `AUDIT_REPORT.md` into the project. The
report covers security, privacy, KVKK/legal risk, correctness and alignment. For every problem it
says **what is missing or wrong, how it is done now, why it matters, and exactly how to fix it**,
then gives a **Ship / Ship with fixes / Do not ship** verdict and a fix plan.

Runs **Claude Opus 5.5 at high effort** in an isolated, read-only Claude Code session.

```
Claude Code harness
 ├── CLAUDE.md        → main rules (role, scope, objectivity, evidence standard)
 ├── workflow/        → audit steps (6 passes, rubric, report template)
 ├── permissions/     → permission and access limits (hard-enforced guard hook)
 ├── memory/          → reviewed lessons from earlier audits
 ├── tests/           → agent performance tests (seeded fixtures + scorer)
 └── AUDIT_REPORT.md  → final report, written into the audited project
```

## Audit a project
```powershell
.\scripts\audit.ps1 C:\path\to\project
.\scripts\audit.ps1 C:\path\to\project -Request "What I originally asked the builder to make"
.\scripts\audit.ps1 C:\path\to\project -Spec C:\path\to\spec.md
.\scripts\audit.ps1 C:\path\to\project -Sandbox         # also run the project's tests in Docker
.\scripts\audit.ps1 C:\path\to\project -Interactive     # live session, ask follow-ups
.\scripts\audit.ps1 C:\path\to\project -DryRun          # everything except the model call (free)
```
Cross-platform equivalent: `node scripts/audit.mjs <path> [--request "…"] [--spec f] [--sandbox] [--interactive] [--budget 10] [--yes] [--dry-run]`

**For the best audits**, put a `REQUIREMENTS.md` in each project (template:
[workflow/REQUIREMENTS.template.md](workflow/REQUIREMENTS.template.md)). Without one, the auditor
infers requirements from the docs and lowers its confidence.

### What you get
| Where | What |
|---|---|
| `<project>/AUDIT_REPORT.md` | The report. Older reports move to `<project>/.audit/history/`. |
| Terminal | Verdict, finding counts, integrity check, blocked calls, sandbox result, cost, and the auditor's summary |
| `runs/<run-id>/` | Transcript, scanner and sandbox output, guard log, prompt, report copy, `result.json` |

### How the report reads
1. Executive summary and verdict
2. Scope (including whether the tests were actually run)
3. What was built: architecture and data flow
4. Requirements traceability: Met / Partial / Missing / Contradicted
5. Pros & cons
6. **Gap analysis**: what is *missing*, what is *incorrect*, and what is *weak*
7. **Findings**. Each one has its severity, evidence, location, the current code, why it matters, **fix steps**, how to verify the fix, and an effort estimate (S/M/L).
8. Privacy policy vs. actual behaviour
9. Scanner and test results, coverage gaps
10. Assumptions and untested risks
11. Changes since the last audit
12. **Fix plan**: *before release* / *next iteration* / *later*, plus the verdict to expect once the first tier is done
13. Disclaimer, then a machine-readable JSON appendix

### Exit codes (CI uses them)
`0` Ship / Ship with fixes · `2` Do not ship · `3` permission violation · `4` run error

## Objectivity
The auditor measures the code against the requirements, Turkish law (KVKK etc.) and recognised
standards (OWASP Top 10 / ASVS / LLM Top 10, CWE), not against taste or the README. Before keeping a
serious finding it looks for the mitigation that would prove it wrong. A claim that something is
"missing" needs a documented search. Rules: [workflow/rubric.md](workflow/rubric.md).

## Sandbox tests (on by default, needs Docker)
The sandbox is on by default (`sandbox.enabled` in `audit.config.json`; `-NoSandbox` / `--no-sandbox`
turns it off). Without Docker running, the runner prints "DYNAMIC TESTING NOT DONE" and the report
says so and caps confidence at Medium. Projects with module folders (`m1/`, `m2/`, …) get one test
run per module, each with its own install. Coverage: `scans/inventory.json` lists every module;
small projects require a full read (no sampling), and `pip-audit` covers `requirements*.txt` at any
depth plus `pyproject.toml` dependencies (status `partial` if any file could not be audited).

Without the sandbox the audit is static: nothing from the project runs. With the sandbox, before the
model starts, the runner copies the project and runs its own test suite (`npm test`, pytest or
unittest) in a throwaway container:
- **Copy only:** the original folder is never mounted.
- **Locked down:** no host environment variables, so no API keys inside. Non-root user, no
  capabilities, CPU, memory and process limits, and timeouts.
- **Network:** allowed for installing dependencies; the test phase runs with **no network**.

The auditor reads the results as evidence: failing tests become verified findings. Setup: install
[Docker Desktop](https://www.docker.com/products/docker-desktop/). Without Docker, `-Sandbox` is
reported as "skipped". Details: [permissions/POLICY.md](permissions/POLICY.md#sandbox---sandbox-runner-only).

## Lessons memory
The auditor reads [memory/lessons.md](memory/lessons.md) at the start of every run. It holds
generic checks learned from earlier audits. The auditor can *propose* new lessons, but only you
can add them:
```powershell
npm run lessons -- list                                  # candidates from recent runs
npm run lessons -- accept <key>                          # add one (optionally --text "edited")
npm run lessons -- reject <key>
npm run lessons -- add "Check X before Y" --category security
```
Lessons must stay generic: no project names, paths, code, secrets or personal data. The script
refuses those.

## GitHub Actions
1. Push this harness to its own GitHub repo (it can be private).
2. In the **project** repo:
   - copy [ci/github/project-audit.yml](ci/github/project-audit.yml) to `.github/workflows/audit.yml`
   - Settings → Secrets → `ANTHROPIC_API_KEY`
   - Settings → Variables → `AUDIT_HARNESS_REPO` = `<you>/<harness-repo>`
   - optionally `AUDIT_BUDGET_USD` (default 10)
   - if the harness repo is private, add a secret `AUDIT_HARNESS_TOKEN`: a fine-grained token with read access to it
3. Start an audit by hand (Actions → Final-stage audit → Run workflow), or add the label **`audit`** to a pull request.

You get:
- a sticky PR comment with the verdict, a top-findings table with fixes, and the "fix before release" list
- the full report as a workflow artifact
- a failed check when the verdict is "Do not ship"

The workflow runs the sandbox by default, since GitHub runners have Docker. API usage is billed per
run, so it never triggers on every push.

## Safety model (short version)
- Runs in its own session from this folder: your user settings, plugins and MCP connectors are **not** loaded.
- The guard hook blocks:
  - every write except `AUDIT_REPORT.md`, including writes to the auditor's own lessons file
  - any read outside the project and the harness
  - non-read-only shell commands
  - web queries containing code, secrets or personal data
  - unredacted secrets in the report
- Dangerous repo git config is neutralised, or git is disabled. The project is hashed before and after the run; any other change fails it with exit code 3.
- Details: [permissions/POLICY.md](permissions/POLICY.md).

## Setup (one time)
- Node ≥ 20, Claude Code CLI logged in.
- Scanners: `.\scripts\install-scanners.ps1` (Linux: `scripts/install-scanners.sh`). Missing scanners
  don't block an audit; they show up as coverage gaps in the report.
- Optional: Docker Desktop for `-Sandbox`.
- Settings: [audit.config.json](audit.config.json) sets the model, effort, budget cap (USD, headless
  only), the large-project warning threshold, excluded folders, and the sandbox limits.

## Testing the auditor
```powershell
npm test                                   # free: guard, linter, scorer, sandbox, lessons, PR comment
npm run score                              # real audits of all 4 fixtures (costs 4 Opus runs)
npm run score -- --only webapp-vuln        # one fixture
node tests/score.mjs --rescore runs\<id>   # re-score an archived run, free
```
Pass bar:
- recall ≥ 80% on the planted flaws
- 0 High/Critical false positives on `clean-project`
- 0 permission violations

Scoreboards are saved in `tests/results/`.

## License and security
MIT, see [LICENSE](LICENSE). Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).
`tests/fixtures/` is intentionally insecure test data.

## Limits
- Legal findings are risk flags for a lawyer to review, not legal advice. Coverage is Turkey (KVKK etc.) plus a global baseline; GDPR and US laws are listed as "not assessed".
- No penetration testing. Without `-Sandbox`, nothing is executed.
- An LLM auditor can miss things. The tests measure how often.
