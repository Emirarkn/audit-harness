# Pass 2 — Requirements & Alignment

Three kinds of alignment: **(A) spec**, **(B) AI/LLM safety**, **(C) ethics**. Finding IDs: `ALN-###`.

## A. Spec alignment: requested vs delivered
1. Collect requirements from REQUIREMENTS.md, `-Spec`, and `-Request`. Number them R1, R2, …
   If there are none, derive *inferred* requirements from README/docs, mark them `(inferred)`,
   and set verdict confidence no higher than Medium.
2. For each requirement, find the implementing code and give it a status:
   | Status | Meaning |
   |---|---|
   | **Met** | The implementing code exists and plausibly works (cite `path:line`). |
   | **Partial** | Some of it exists, there are stubs or TODOs, or it only covers the happy path. |
   | **Missing** | No implementing code found. |
   | **Contradicted** | The code does something different from, or opposite to, the requirement. |
   | **Unverifiable** | It depends on runtime, infra or external state you can't inspect. |
3. Check the **docs against the code**. Every feature claimed in the README or docs must exist.
   A claimed but missing feature is an ALN finding (misleading docs), at least Medium.
4. Look for **unfinished work**: `TODO`, `FIXME`, `NotImplemented`, `pass`-only functions, mock
   data in production paths, hard-coded test credentials, commented-out core logic.
5. Look for **scope creep**: significant functionality nobody asked for, especially functionality
   that collects data, calls external services, or widens permissions.

## B. AI/LLM safety alignment (only if the target uses LLMs or agents)
Based on the OWASP Top 10 for LLM Applications (2025):
- **Prompt injection:** does untrusted input (user text, web pages, files, emails, tool results)
  reach prompts without clear separation? Does any of it reach the *system* prompt?
- **Excessive agency:**
  - tools that run shell commands, file writes, payments, emails or DB writes with no allowlist,
    no confirmation step and no scope limits
  - autonomous loops with no iteration or cost cap
- **Improper output handling:** LLM output passed into `eval`, shell, SQL, HTML (XSS), file
  paths or URLs without validation.
- **Sensitive information disclosure:** secrets or PII in prompts; system prompts holding
  credentials; logging of full prompts or responses that contain personal data.
- **System prompt leakage:** security that depends on the prompt staying secret.
- **Unbounded consumption:** no max_tokens, rate limits or budget caps; retry storms.
- **Supply chain:** unpinned model IDs or packages; models or weights loaded from untrusted sources.
- **Misinformation / overreliance:** high-stakes outputs (legal, medical, financial) presented
  without disclaimers or a human-review step.
- **Data handling:** personal data sent to LLM providers outside Turkey. Hand this to pass 4
  (KVKK yurt dışına aktarım).

## C. Ethical alignment
- **Deceptive or manipulative patterns:**
  - dark patterns: pre-ticked consent, a "cancel" made hard to find, confirm-shaming, fake scarcity or urgency
  - a bot impersonating a human, or the AI involvement not being disclosed
- **Fairness:** decisions about people (scoring, filtering, pricing, moderation) based on
  protected attributes or proxies, with no human review.
- **Misuse potential:** features that are easy to turn to harm (mass scraping of personal
  profiles, spam, surveillance, credential collection) with no safeguards.
- **Transparency:** does the user know what is collected, what is automated, and what is AI-generated?

## Output
- the traceability table (report section 4)
- ALN-* candidate findings
- notes handed to pass 4
