# Pass 5 — Code Correctness & Reliability

Finding IDs: `COR-###`. You cannot run the code yourself, so reason carefully and trace actual
paths. Use "Verified" when the code clearly shows the defect, and "Inferred" when it depends on
input or runtime behaviour.

## Sandbox test results (when `scans/sandbox.json` status is `ran`)
- Failing tests, and dependencies that fail to install, are **Verified** COR findings. Cite
  `scans/sandbox-test.log` (or `sandbox-install.log`) plus the code the failure points to. Explain
  the cause from the code, not only the error message.
- README or docs claiming "all tests pass" while the sandbox shows failures is also an ALN finding.
- Passing tests prove only what they assert. Still check what they leave untested.
- `timeout` or `failed` (infrastructure problem) is a coverage gap, not a project defect, unless
  the log shows the project's own code hanging.

## Checklist
**Business logic**
- Trace each Met/Partial requirement's main path end to end. Does it do what's claimed?
- Off-by-one errors, wrong comparisons, inverted conditions, wrong units, currency or decimal
  maths done in floats, timezone and date mistakes, locale issues (including Turkish `İ/ı` in case
  conversion).
- Pagination, batching and loops: are the first and last items handled? What about an empty input?

**Error handling**
- Swallowed exceptions (`except: pass`, empty `catch`), errors logged but then ignored, missing
  `await`, unhandled promise rejections.
- Failure paths that leave partial state behind (half-written files, partial DB writes with no
  transaction).
- Retries without backoff or a limit; no timeouts on network calls.

**Edge cases & input validation**
- Null/None/undefined, empty strings or lists, very large inputs, unicode, and malformed external
  data (APIs, scraped HTML, LLM output that doesn't match the expected JSON).

**Data integrity**
- Race conditions (check-then-act, concurrent writes), missing unique constraints, non-idempotent
  jobs that may run twice, schema migrations that lose data.

**Tests**
- Do tests exist for the core logic? Do they assert anything meaningful, or only smoke-test?
  Are they skipped? Do they mock away the very thing under test?
- Is there a test command? If the sandbox didn't run, infer from config whether it would pass.
- **Missing tests** for a core requirement, a security control, or money/data-integrity logic are
  `missing` findings (Medium when the logic is core, Low otherwise). Name the test cases to add.

**Performance & resource use**
- N+1 queries, unbounded reads into memory, missing indexes on obvious lookups, synchronous I/O
  in hot paths, unbounded LLM or API calls in loops.

**Operations**
- Missing or broken config for the claimed deploy target; required env vars not documented.
- No health check, no logging at failure points, no graceful shutdown for workers or schedulers.
- Scheduled jobs: overlapping runs, no lock, no alerting on failure.
- Single points of failure that the docs claim are resilient.

**Code quality (only when it creates real risk)**
- Dead code on critical paths, copy-pasted logic that has drifted apart, magic numbers that encode
  business rules. Don't report style preferences.

## Missing-control sweep
Before leaving this pass, list what a project of this type should have and confirm each exists:
input validation at every external boundary, error handling and timeouts on external calls,
logging at failure points, configuration documented, tests for core paths, a way to run it as
documented. Anything absent is a `missing` candidate with the search you did as evidence.

## Output
COR-* candidates. Pros (things done well) noted for report section 5.
