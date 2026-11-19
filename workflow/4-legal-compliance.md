# Pass 4 — Legal & Compliance Risk

Finding IDs: `LEG-###`. **You flag risks for qualified legal review. You do not give legal rulings.**
Phrase findings as "Potential non-compliance with …, needs review", and cite the code or
document that triggers the flag. Only use web lookups to confirm public legal text or current
thresholds, never to send project details.

Jurisdiction: **Turkey** plus the **global baseline**. GDPR, the EU AI Act and US laws are *not assessed*.

## KVKK — Law No. 6698 on the Protection of Personal Data
Apply this whenever the target processes data about identifiable people.
| Topic | What to check in the project |
|---|---|
| **Legal basis** (Art. 5, 6) | Is there a plausible basis for each processing purpose? Is açık rıza used where it's needed (special-category data, marketing, optional processing), and is it freely given, specific and informed, rather than bundled into the terms or pre-ticked? |
| **Aydınlatma yükümlülüğü** (Art. 10) | Is there a notice telling people who the data controller is, the purposes, who data is shared with, how it's collected, the legal basis, and their Art. 11 rights? It must be shown at or before the point of collection. |
| **Special categories** (Art. 6) | Health, biometric, genetic or religious data etc. need stricter conditions and protective measures. Flag any processing found. |
| **Yurt dışına aktarım** (Art. 9, amended by Law 7499, in force 1 June 2024) | Personal data sent to services outside Turkey (cloud, LLM APIs, analytics, email/SMS providers) needs an adequacy decision, appropriate safeguards (e.g. standard contracts notified to the Board), BCRs, or a narrow incidental-transfer exception. Flag every foreign recipient of personal data that you find. |
| **Veri güvenliği** (Art. 12) | Technical and administrative measures: access control, encryption, logging. Breach notification to the Board is expected within 72 hours. Is there any incident-handling path? |
| **Deletion / retention** (Art. 7 + deletion regulation) | Is there a deletion or anonymization mechanism? Controllers registered in VERBİS need a retention and destruction policy (saklama ve imha politikası). |
| **VERBİS** | Registration may be required depending on the controller's size or how central data processing is to the business. Flag it as "check whether VERBİS registration applies (verify current thresholds)". |
| **Data subject rights** (Art. 11, 13) | Is there a channel to handle requests, which must be answered within 30 days? |
| **Cookies** (Board cookie guidance) | Non-essential (analytics or marketing) cookies are set before consent, or with pre-ticked or bundled consent. |

## Other Turkish laws (apply when relevant)
- **6563 E-Commerce & commercial electronic messages:**
  - marketing SMS or email sent without prior consent
  - no İYS (İleti Yönetim Sistemi) integration for commercial messages
  - no opt-out link
  - provider identity and contact details missing on commercial sites
- **6502 Consumer Protection** (if the target sells to consumers):
  - distance sales: pre-contract information form, mesafeli satış sözleşmesi, 14-day cayma hakkı
  - subscription cancellation as easy as sign-up
  - unfair contract terms
  - hidden costs or auto-renewal not disclosed
- **5651 Internet Law:** if the target hosts user content or offers internet access to the public,
  check for content-removal handling and the obligations of access and hosting providers. Flag
  only when it's clearly relevant.
- **FSEK 5846 Intellectual & artistic works:** reuse of scraped or copied content, images, fonts
  or datasets without a license. Copied third-party code with no attribution.

## Global baseline
- **Open-source licenses:**
  - The project's own LICENSE: is it present? Is it consistent with `package.json`/`pyproject`?
  - Dependency licenses compatible with the project's license. Example: GPL/AGPL code in an MIT
    or proprietary product that is distributed or offered as a network service (AGPL).
  - Missing NOTICE or attribution where Apache-2.0 or BSD require it.
- **Third-party ToS & APIs:**
  - scraping sites whose ToS or robots.txt forbid it
  - bypassing rate limits or CAPTCHAs
  - violating the ToS of an API or LLM provider (usage policies, data-use restrictions, resale)
  - using unofficial or private APIs
- **Regulated activity flags:** payments (PCI-DSS scope if raw card data is touched), health,
  finance, gambling, minors' data. Flag these for specialist review.

## Severity guidance
- **Critical:** special-category or large-scale personal data sent abroad with no safeguards, or
  processing that is clearly unlawful (e.g. covert collection), *and* it's in production code paths.
- **High:**
  - personal data processed with no aydınlatma at all
  - marketing messages sent without consent
  - an AGPL or GPL conflict in a distributed product
  - scraping that clearly violates ToS
- **Medium / Low:** missing documentation, unclear legal bases, attribution gaps.

## Output
LEG-* candidates, each with the triggering file:line or document, and the phrase **"needs
qualified legal review"** in its recommendation.
