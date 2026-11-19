# 00 — Orchestration

You are running an **AUDIT RUN** (CLAUDE.md Part A). This file sets the order of work.

## Inputs (given in the run prompt)
- `AUDIT_TARGET`: absolute path of the project under audit (read-only, except `AUDIT_REPORT.md`).
- `AUDIT_RUN_DIR`: this run's folder in the harness; `scans/` contains scanner output and
  `scans/_summary.json` lists which scanners ran, were missing, or failed.
- Requirements source, one or more of:
  - `<target>/REQUIREMENTS.md`
  - a spec file passed with `-Spec`
  - request text passed with `-Request`
  - "none"
- Previous report path, if one exists in `<target>/.audit/history/`.
- Sandbox test results, if the runner ran the target's tests in an isolated container:
  `scans/sandbox.json` plus `scans/sandbox-install.log` and `scans/sandbox-test.log`.
- `memory/lessons.md` in the harness: reviewed lessons from earlier audits. Read it first. They
  are checks to remember, not facts about this project.

## Order
| Step | File | Produces (keep as working notes, not files) |
|---|---|---|
| 1 | `1-project-scan.md` | Inventory, architecture sketch, data-flow map, review plan |
| 2 | `2-requirements-alignment.md` | Traceability table, ALN-* candidates |
| 3 | `3-security-privacy.md` | SEC-* and PRV-* candidates, privacy-policy comparison |
| 4 | `4-legal-compliance.md` | LEG-* candidates |
| 5 | `5-correctness-reliability.md` | COR-* candidates |
| 6 | `6-final-review.md` | Verified, deduped, ranked findings; verdict; then the report |

Rules for the whole run:
- Do the passes **in order**. Later passes may add evidence to earlier candidates.
- Record each candidate the moment you find it: ID, file:line, what you saw, and a draft severity.
  Pass 6 decides the final status.
- Prefer reading the real code over searching for keywords. Grep tells you where to look; opening
  the file is what verifies a finding.
- Budget your effort: spend most of it on entry points, auth, data handling, external calls, LLM
  calls, and anything a requirement depends on.
- **Look for absence, not only presence.** For each requirement and each control a project of
  this type needs (auth, input validation, error handling, consent, tests, logging…), ask
  "where is it?". If a thorough search finds nothing, that is a `missing` finding.
- **Stay objective** (`rubric.md` → "Objectivity standard"): measure against the requirements,
  the law and recognised standards, never against taste or the builder's own claims.
- Each candidate needs enough notes to write the full finding later: what, current code, why it
  matters, fix steps, how to verify.

## Stop conditions
- Stop early only if the target is empty or unreadable. Write a short report stating that, with
  verdict "Do not ship", confidence "Low".
- If tool calls keep getting blocked, don't loop. Finish with what you have and record the gaps.

## Finish
Write `<AUDIT_TARGET>/AUDIT_REPORT.md` exactly per `report-template.md`, then reply with the
≤ 10-line summary defined in CLAUDE.md A7.
