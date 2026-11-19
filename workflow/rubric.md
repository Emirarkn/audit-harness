# Rubric

## Severity
| Level | Definition | Examples |
|---|---|---|
| **Critical** | Exploitable now or certain to cause serious harm in production: compromise, mass data exposure, clearly unlawful processing, data loss. | A live secret committed to the repo; unauthenticated admin/DB access; SQL injection on a public endpoint; an LLM agent with an unrestricted shell tool driven by user input. |
| **High** | Serious risk that needs a likely precondition, or a core requirement that is broken. | IDOR; PII logged in plaintext; personal data sent abroad with no safeguards or notice; privacy policy contradicts the code; a core feature missing or contradicted. |
| **Medium** | Real weakness with limited impact, or one that needs an unlikely precondition. | Missing rate limits; swallowed exceptions in a non-core path; README claims a minor feature that doesn't exist; missing license attribution. |
| **Low** | Hardening or quality issue with minor impact. | Missing security headers; unpinned dev dependencies; weak test coverage of a non-critical module. |
| **Info** | Observation, no risk on its own. | Architecture notes; suggestions. |

Rate the **realistic** impact in this project's context. A vulnerable dependency function that is
never called is at most Low (Inferred).

## Evidence status
| Status | Meaning |
|---|---|
| **Verified** | You opened the cited code or config, and it unambiguously shows the issue (or, for an absence, you did the search described below). |
| **Inferred** | Strong indication from the code, but it depends on runtime, config or input you couldn't see. |
| **Untested risk** | A plausible concern that wasn't checked: listed for follow-up, not counted in the verdict. |

**Absence claims** (kind `missing`) are Verified only when you searched the whole codebase for
every reasonable form of the thing (names, libraries, middleware, config keys) and read the code
path where it would have to be. Name the search in the gap analysis ("searched: rateLimit,
express-rate-limit, throttle; read src/server.js middleware chain"). A sandbox test log counts as
Verified evidence for test failures (cite `scans/sandbox-test.log`).

## Kind
| Kind | Meaning | Example |
|---|---|---|
| **missing** | Needed (by a requirement, law, or standard practice) and absent. | No auth on admin routes; no aydınlatma metni; no tests for payment logic. |
| **incorrect** | Present, but does the wrong thing or contradicts requirements/docs. | Off-by-one pagination; privacy policy says "not shared" but code sends data to an SDK. |
| **weak** | Present and working, but insufficient for its purpose. | MD5 password hashing; validation that only checks the client side; a rate limit of 10,000/min. |

## Effort
`S` under an hour · `M` under a day · `L` more than a day. Estimate for a developer who knows the
code; it orders the fix plan, it is not a quote.

## Writing a finding
A finding is useful only if the reader can fix it without re-auditing. Each finding answers:
1. **What is missing or wrong**: one or two plain sentences.
2. **How it is done now**: the actual code, copied from the cited location (≤ 8 lines, secrets
   redacted). For a `missing` finding, show where it should be (e.g. the route registration
   without middleware).
3. **Why it matters**: a concrete scenario in this project, not a generic risk statement.
4. **Fix — do this**: numbered steps that name the file, function, library, or setting. Prefer
   the project's existing stack and patterns. A short code sketch where it removes ambiguity.
5. **Verify the fix**: the test to add or the check to run.

Not acceptable: "improve security", "add validation", "consider using best practices", or a fix
that would not work in this stack. Low and Info findings may use a compact block (one paragraph
covering what, why, and fix).

## Objectivity standard
- **Judge against references, not taste.** The yardsticks are: the requirements, the project's
  own docs and privacy notice, the law (A2 scope), and recognised standards (OWASP Top 10, OWASP
  ASVS, OWASP LLM Top 10, CWE). Style preferences are at most Info, and only when they create risk.
- **Same code, same result.** Severity follows this rubric, not the tone of the README, the size
  of the project, or how many other findings there are. Don't inflate to look thorough or deflate
  to look fair.
- **Builder-neutral.** Never speculate about who wrote the code or why. Describe the code.
- **Steelman before you report.** For every High/Critical, look for the mitigation that would
  make you wrong (middleware, framework defaults, config, validation elsewhere) and say in the
  finding that you checked.
- **Balance is evidence-based.** Pros are real strengths you saw in the code, with locations.
  An empty pros list is allowed; padding is not.
- **Unknown is not absent.** If you could not check something, it goes in "Assumptions & untested
  risks", not into a finding.

## Verdict
| Verdict | Rule |
|---|---|
| **Do not ship** | Any **Verified Critical**, **or** ≥ 2 Verified High in security/privacy/legal, **or** a core requirement is Missing or Contradicted. |
| **Ship with fixes** | Any Verified High or Inferred Critical not covered above, or ≥ 3 Medium. |
| **Ship** | Only Medium (≤ 2), Low, or Info findings. |

## Confidence
| Level | When |
|---|---|
| **High** | Requirements were provided, the core code was fully read, and the key scanners ran. |
| **Medium** | One of those is missing (e.g. no requirements, or sampled review, or major scanners missing, or the tests were not run, or a scanner is `partial`). |
| **Low** | Two or more are missing, or large parts were unreadable. |

## Finding ID prefixes
`SEC` security · `PRV` privacy · `LEG` legal/compliance · `COR` correctness/reliability · `ALN` alignment (spec, LLM safety, ethics)
