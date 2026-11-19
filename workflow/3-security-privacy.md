# Pass 3 — Security & Privacy

Finding IDs: `SEC-###` (security), `PRV-###` (privacy). Confirm every scanner lead in the code.

## Security checklist
**Secrets & config**
- Hard-coded keys, tokens, passwords, or connection strings in code, config, notebooks, or the
  git history (gitleaks results plus manual grep for `key`, `secret`, `token`, `password`, `Bearer`).
- Is `.env` committed? Is `.env` missing from `.gitignore`? Do example env files contain real values?
- Debug mode, verbose errors or stack traces exposed in production config; permissive CORS (`*` with credentials).

**Authentication & authorization**
- Routes, APIs, admin pages or functions reachable without authentication.
- Missing **object-level** checks (IDOR): can user A read or change user B's data by changing an ID?
- Role checks done only in the frontend. JWTs that aren't verified, use `alg: none`, have weak
  secrets, or never expire. Session fixation. Missing logout or invalidation.
- Supabase/Firebase: RLS disabled or overly broad policies; a service-role key shipped to the client.

**Injection & input handling**
- SQL/NoSQL queries built with string concatenation or interpolation.
- Command injection (`exec`, `subprocess(..., shell=True)`, `child_process.exec` with input).
- Path traversal (user-controlled file paths); SSRF (fetching URLs the user supplies, including LLM-supplied URLs).
- XSS (`innerHTML`, `dangerouslySetInnerHTML`, templates with autoescaping turned off).
- Unsafe deserialization (`pickle`, `yaml.load`, `eval`).
- File uploads with no type or size limits, served from the same origin.

**Dependencies & supply chain**
- Known CVEs (osv-scanner / npm audit / pip-audit output). Confirm the vulnerable function is
  actually reachable before rating it High or above.
- Unpinned versions, no lockfile, abandoned or typosquat-looking packages, `curl | sh` in setup scripts.

**Crypto & transport**
- Weak hashing for passwords (MD5/SHA1/unsalted), home-made crypto, disabled TLS verification
  (`verify=False`, `rejectUnauthorized: false`), HTTP for sensitive traffic.

**Operational security**
- No rate limiting on login, OTP or expensive endpoints. No CSRF protection on cookie-authenticated
  state changes. Missing security headers on web apps.
- Logging: secrets or tokens in logs; no audit trail for admin actions.
- CI/CD: secrets printed in workflows; `pull_request_target` misuse; overly broad tokens.

## Privacy checklist
1. **PII inventory** (from the pass 1 data-flow map): which personal data, why, where it's stored,
   and how long it's kept. Watch for **special categories** (health, biometrics, religion,
   ethnicity, criminal records, union membership): KVKK Article 6.
2. **Data minimization:** is anything collected that is never used?
3. **Retention & deletion:** is there a deletion path, a retention limit, a cleanup job? Or does
   data live forever?
4. **Logging & analytics:** is PII written to logs, error trackers (Sentry etc.), analytics,
   or LLM prompt logs?
5. **Third parties & transfers:** every external service that receives personal data, and its
   region. Flag providers outside Turkey for pass 4.
6. **At rest & in transit:** is sensitive data encrypted? Who can access the DB, buckets or backups?
7. **Data subject rights:** can a user see, export, correct, or delete their data?

## Privacy policy vs. actual behaviour (report section 8)
If a privacy policy, aydınlatma metni, cookie notice, or terms exist, build a table comparing
**what the document claims** with **what the code does**, citing locations for both. Any
contradiction is a finding: at least High if it hides collection or sharing of personal data.
If personal data is processed and **no** notice exists at all, that is a PRV finding plus a LEG
finding (KVKK Article 10).

## Output
SEC-* and PRV-* candidates, the privacy comparison table, and notes for pass 4.
