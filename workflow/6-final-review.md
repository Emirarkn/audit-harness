# Pass 6 — Independent Final Review

You are now the **skeptical reviewer** of your own candidate findings. The report's credibility
depends on this pass.

## Steps
1. **Re-verify every candidate.** Re-open the cited location.
   - If the code no longer supports the claim, or you misread it, **drop** the finding.
   - If it's plausible but unconfirmed, set it to **Inferred**, or move it to
     "Assumptions & untested risks".
   - Confirm that each line number is correct, and fix it if not.
2. **Steelman: try to prove yourself wrong.** For every candidate, and always for High/Critical,
   look for the mitigation you might have missed: middleware, wrappers, framework defaults,
   validation done elsewhere, config that disables the risky path. If one exists, downgrade or
   drop. For `missing` findings, repeat the search with other names before keeping it.
3. **Dedupe.** Merge findings that share a root cause (e.g. one missing auth middleware that
   affects 5 routes is a single finding listing 5 locations). Cross-reference between categories
   instead of repeating, e.g. "see PRV-002".
4. **Calibrate severity** with `rubric.md`. Ask:
   - Would a competent senior reviewer agree?
   - Is it reachable in production?
   - Does the impact match the severity level?
5. **Separate fact from assumption.** Every statement in the executive summary must trace to a
   Verified finding or the traceability table.
   **Objectivity check** (`rubric.md`): would the same code get the same severity in a different
   project? Is any severity driven by the README's tone, by taste, or by the number of findings?
   Fix it if so.
5b. **Classify each finding** as `missing`, `incorrect` or `weak`, estimate effort (S/M/L), and
   build the gap analysis (report section 6) from that classification.
5c. **Write the fix for each finding** per `rubric.md` → "Writing a finding": the current code,
   why it matters here, numbered fix steps naming files and functions, and how to verify. Re-read
   each fix and ask: could a developer do this tomorrow without asking me anything? Would it work
   in this stack?
6. **Compare with the last audit** if `.audit/history/` has a report. Mark each earlier finding as
   Fixed, Still open, or Not re-checked, and mark each new finding as New.
7. **Decide the verdict** using the rules in `rubric.md`, and set the confidence level.
8. **Pros & cons.** Give a balanced list. Pros must be real strengths you saw in the code, not filler.
9. **Fix plan.** Three tiers: *Before release* (everything that drives the verdict), *Next
   iteration*, *Later / hardening*. Within a tier, order by severity, then by effort (cheap first).
   Group findings that share one fix. State the verdict expected once *Before release* is done.
9b. **Lesson candidates.** If this run taught you a generic auditing lesson that is not already in
   `memory/lessons.md`, add up to 3 to `lessonCandidates` in the JSON. Generic only: no project
   names, paths, code, secrets or personal data.
10. **Write the report** following `report-template.md`, including the `findings-json` appendix.
    Its counts must match the tables.
11. **Self-check before writing:**
    - no unredacted secrets
    - no personal data from the target reproduced
    - every finding has a location, a kind, an effort, concrete fix steps and a verification
    - no fix is generic ("improve security", "add validation")
    - no finding just restates a scanner hit without confirming it in the code
    - **coverage ledger complete:** every module in `scans/inventory.json` appears in the
      report's coverage table as Full / Sampled (reason) / Not reviewed; if the prompt said FULL
      READ REQUIRED, no module is Sampled. Go back and read it now if one is.
    - **tests:** the report's "Dynamic testing" line matches `sandbox.json` (per module when
      present). If tests were not run, the reason is given and confidence is not High.
    - **scanners:** a `partial`/`failed` scanner is listed with the unaudited files and how they
      were covered by hand; no claim of "no vulnerable dependencies" covers unaudited files.

## Then
Reply with the ≤ 10-line summary (CLAUDE.md A7).
