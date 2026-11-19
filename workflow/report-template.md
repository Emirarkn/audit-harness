# AUDIT_REPORT.md template

Fill in every section in this order. Keep the headings exactly as written: the runner and the
test scorer parse them. Replace `<…>` placeholders. If a section has nothing to report, write
"None found." Never delete a section.

The reader is the person who has to **fix** the project. Every finding must tell them what is
missing or wrong, how it is done now, why it matters, and exactly what to do about it
(`rubric.md` → "Writing a finding").

---

````markdown
# Audit Report — <project name>

| | |
|---|---|
| **Verdict** | <Ship / Ship with fixes / Do not ship> |
| **Confidence** | <High / Medium / Low>: <one-line reason> |
| **Audited path** | <target path> |
| **Date** | <YYYY-MM-DD> |
| **Auditor** | project-auditor harness · claude-opus-5-5 · effort high |
| **Findings** | Critical <n> · High <n> · Medium <n> · Low <n> · Info <n> |
| **Fix effort** | <n> × S · <n> × M · <n> × L |

## 1. Executive summary
<3–6 sentences: what the project is, the overall state, the most important risks, and the verdict
rationale. Only use claims backed by findings or the traceability table. Neutral tone: no praise,
no alarmism.>

## 2. Scope & inputs
- **Requirements source:** <REQUIREMENTS.md / -Spec file / -Request text / none (inferred from docs)>
- **Project type:** <web app/API · script/automation · AI agent/LLM app>
- **Reviewed:** <areas fully read>
- **Sampled / not reviewed:** <areas, and why>
- **Dynamic testing:** <sandbox ran the test suite: N passed / M failed (per module if several) · or NOT RUN, and why>

| Module | Files / lines | Coverage | Reason / what was skipped |
|---|---|---|---|
| <name from inventory.json> | <n> / <n> | <Full / Sampled / Not reviewed> | |
- **Not assessed:** GDPR, EU AI Act, US privacy laws, penetration testing, <other>

## 3. What was built
<Architecture: components, external services, entry points.>

**Data flow:** <where personal or sensitive data enters → is stored → leaves (note countries)>

## 4. Requirements traceability
| ID | Requirement | Status | Evidence |
|---|---|---|---|
| R1 | <text> | <Met / Partial / Missing / Contradicted / Unverifiable> | <path:line or note> |

## 5. Pros & cons
**Pros**
- <real strength, with location>

**Cons**
- <main weakness, with finding IDs>

## 6. Gap analysis
What the project needs but does not have, what it has but does wrong, and what it has but too
weakly. One line per finding; details are in section 7.

**Missing** (required by a requirement, law, or standard practice, and absent)
- <ID>: <what is missing> — searched: <how you established absence>

**Incorrect** (present, but does the wrong thing or contradicts requirements/docs)
- <ID>: <what is wrong>

**Weak** (present and working, but insufficient)
- <ID>: <what is insufficient>

## 7. Findings
| ID | Severity | Kind | Evidence | Location | Title | Effort |
|---|---|---|---|---|---|---|
| SEC-001 | <sev> | <Missing/Incorrect/Weak> | <Verified/Inferred> | `path:line` | <title> | <S/M/L> |

<Then one block per finding, grouped under these sub-headings, in severity order. Empty
category: "None found.">

### 7.1 Security

#### SEC-001 — <title>
- **Severity:** <sev> · **Kind:** <Missing/Incorrect/Weak> · **Evidence:** <status> · **Effort:** <S/M/L>
- **Location:** `path:line` <(+ other locations with the same root cause)>
- **Standard:** <OWASP ASVS / OWASP Top 10 / OWASP LLM Top 10 / CWE / KVKK article — optional>

**What is missing or wrong.** <one or two sentences>

**How it is done now.**
```<lang>
<≤ 8 lines copied from the cited location; secrets redacted to the first 4 characters>
```

**Why it matters.** <a concrete scenario: who can do what, or what breaks, and the consequence>

**Fix — do this:**
1. <specific step naming the file, function, library or setting>
2. <…>
```<lang>
<optional short sketch of the corrected code>
```

**Verify the fix.** <the test to add or the check to run that proves it is fixed>

### 7.2 Privacy

### 7.3 Legal & compliance
*Risk flags for qualified legal review, not legal advice.*

### 7.4 Correctness & reliability

### 7.5 Alignment (spec · LLM safety · ethics)

## 8. Privacy policy vs. actual behaviour
| Policy / notice says | Code does | Locations | Match? |
|---|---|---|---|
<If no policy exists: state that, and reference the related finding.>

## 9. Scanner & test results
| Tool | Status | Confirmed findings | Notes |
|---|---|---|---|
| gitleaks | <ran / partial / missing / failed / n.a.> | <IDs> | `partial` = some files unaudited; list them in Notes |
| osv-scanner | | | |
| semgrep | | | |
| npm audit | | | |
| pip-audit | | | |
| bandit | | | |
| sandbox tests | <ran / skipped / failed / timeout> | <IDs> | <N passed, M failed; command> |

**Coverage gaps:** <what could not be checked and how you compensated>

## 10. Assumptions & untested risks
- <items with evidence status "Untested risk", and assumptions the verdict depends on>

## 11. Changes since last audit
<"First audit." or a table: Finding · Previous status · Now (Fixed / Still open / New / Not re-checked)>

## 12. Fix plan
**Before release** (blocks the verdict)
1. <action> — <IDs> · <effort>

**Next iteration**
1. <action> — <IDs> · <effort>

**Later / hardening**
1. <action> — <IDs> · <effort>

<When all "Before release" items are fixed, the expected verdict is: <verdict>.>

## 13. Disclaimer
This report was produced by an automated AI auditor using static review, scanner output and,
when enabled, sandboxed test runs. It may miss issues and does not replace a penetration test or
professional security review. Legal and compliance items are risk flags for review by a
qualified lawyer, not legal advice.

## Appendix — findings-json
```findings-json
{
  "verdict": "Do not ship | Ship with fixes | Ship",
  "confidence": "High | Medium | Low",
  "counts": {"Critical": 0, "High": 0, "Medium": 0, "Low": 0, "Info": 0},
  "requirements": [{"id": "R1", "status": "Met"}],
  "findings": [
    {"id": "SEC-001", "category": "security", "severity": "High", "evidence": "Verified",
     "kind": "incorrect", "effort": "S",
     "file": "src/db.js", "line": 42, "title": "SQL built by string concatenation",
     "fix": "Use parameterised queries (db.get(sql, [id])) in src/db.js and add an injection test"}
  ],
  "lessonCandidates": []
}
```
````

Rules for the JSON appendix:
- `category` is one of `security`, `privacy`, `legal`, `correctness`, `alignment`.
- `kind` is one of `missing`, `incorrect`, `weak` (lower case). `effort` is `S` (< 1 hour),
  `M` (< 1 day) or `L` (more).
- `fix` is a one-line summary of the "Fix — do this" steps (≤ 300 characters).
- `file` is relative to the target, with forward slashes. `line` is an integer, or `null` for findings that cover the whole project.
- Include every finding from section 7; leave out section 10 items.
- `counts` must match the findings array.
- `lessonCandidates` (optional, ≤ 3 strings, each ≤ 300 characters): **generic** auditing lessons
  this run taught you that are not already in `memory/lessons.md`. Start each with its category in
  brackets, e.g. "[security] Check that file-upload size limits are enforced server-side, not only
  in the form". Never include project names, file paths, code, secrets or personal data. A human
  reviews them before they are kept.
