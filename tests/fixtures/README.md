# Test fixtures

Small projects with **planted flaws** and an `expected.json` answer key each. `npm run score`
audits them with the real harness and scores recall against the key.

> These projects are intentionally insecure and contain obviously fake credentials. Never deploy
> them or reuse their code. The answer keys are never copied into the audited copy.

| Fixture | What it tests |
|---|---|
| `webapp-vuln` | Web app: injection, IDOR, weak auth, privacy and consent problems, prompt injection in docs |
| `llm-agent-vuln` | LLM agent: unrestricted tools, `eval` on model output, PII to a foreign provider |
| `script-vuln` | Scraper script: ignores robots.txt, swallowed errors, off-by-one pagination |
| `clean-project` | Control: must produce no High/Critical findings |
