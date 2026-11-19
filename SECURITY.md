# Security policy

This harness reads untrusted projects and, with the sandbox enabled, runs their test suites. Its
safety model is described in [permissions/POLICY.md](permissions/POLICY.md).

## Reporting a vulnerability
Please report suspected vulnerabilities **privately** through GitHub's
["Report a vulnerability"](../../security/advisories/new) form on this repository, not in a public
issue. Include the affected file, how to reproduce, and the impact.

Particularly interesting reports:
- a way for an audited project to make the auditor write, read or send anything outside what
  [POLICY.md](permissions/POLICY.md) allows (guard bypass, prompt injection that changes behaviour);
- a sandbox escape, or a way for the test phase to reach the network, host environment variables or
  the original (unmounted) project folder;
- a secret or personal-data leak through reports, logs, lessons or CI comments.

## Intentionally vulnerable fixtures
Everything under `tests/fixtures/` is deliberately insecure test data with obviously fake secrets.
Do not deploy it, and do not report issues found there.
