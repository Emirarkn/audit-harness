# Pass 1 — Project Scan

Goal: know **what actually exists** before judging anything.

## Steps
0. **Read `memory/lessons.md`** (harness folder). Keep its checks in mind for passes 2–6.
1. **Read the scanner results.** Open `$AUDIT_RUN_DIR/scans/_summary.json`, then each scan file.
   Note the scanners that were missing or failed; these are coverage gaps for the report.
   Treat scanner hits as *leads*: each one needs confirming in the code (pass 6).
   If `_summary.json` has a `sandbox` entry, read `sandbox.json` and the two sandbox logs: they
   show whether the dependencies install and the tests pass when actually run. Status
   `skipped` means dynamic testing was not done; say so in the report's scope section.
2. **Inventory.** Use Glob for the file tree, excluding the folders listed in CLAUDE.md A2.
   Record:
   - languages, frameworks, package managers (manifest and lock files)
   - entry points: servers, CLIs, scheduled jobs, workers, agent loops, serverless handlers
   - config and infra: `.env*`, Docker, CI workflows, IaC, deploy configs
   - tests: where they are and roughly how many; the test command, if any
   - docs: README, CLAUDE.md, privacy policy, terms, LICENSE, REQUIREMENTS.md
3. **Classify the target** as one or more of: web app/API, script/automation, AI agent/LLM app.
   This decides which checklist items in passes 3–5 matter most.
4. **Architecture sketch.** Components, how they talk, and external services (DBs, APIs, LLM
   providers, payment, email/SMS, analytics, storage).
5. **Data-flow map.** For every kind of personal or sensitive data:
   - where it enters (forms, APIs, scraping, uploads, LLM inputs)
   - where it is stored, logged, or cached
   - where it leaves (third parties, LLM providers, especially **outside Turkey**)
6. **Project history** (if `.git` exists), read-only:
   - `git log --oneline -n 30`, and `git log --stat -n 10` for recent focus areas
   - `git ls-files` compared with the tree, to see what is untracked
   - look for secrets that were committed and then "removed" (`git log -p -S <pattern>` on suspicious names)
7. **Coverage ledger.** Read `$AUDIT_RUN_DIR/scans/inventory.json` (files and lines per module).
   If the run prompt says FULL READ REQUIRED, plan to open every source file of every module, and
   do not sample. Otherwise write a review plan marking each module Full / Sampled (with reason) /
   Not reviewed. Tick modules off as you read them; pass 6 checks the ledger is complete, and the
   report prints it.
8. **Scanner completeness.** For every scanner with status `partial`, `failed` or `missing`, note
   exactly which files/ecosystems were not covered (the `note` field lists them) and plan the
   manual compensation (e.g. read unaudited requirements files against known CVEs).

## Output (working notes)
Inventory, target classification, architecture sketch, data-flow map, coverage gaps, review plan.
These feed report sections 2 and 3.
