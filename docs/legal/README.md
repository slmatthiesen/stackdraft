# Drafture — Legal Documents

> **⚠️ UNREVIEWED STARTER DRAFTS — REQUIRE LAWYER REVIEW BEFORE LAUNCH.**
> These documents are drafts prepared as a starting point. They are **not legal advice** and **must be reviewed and finalized by a licensed attorney** before Drafture is launched or these documents are published or relied upon.

## What's in this folder

| File | Purpose |
| --- | --- |
| [`terms-of-service.md`](./terms-of-service.md) | The Terms of Service governing use of Drafture: AS-IS/no-warranty, limitation of liability (capped at fees paid / $0), "estimates are not quotes," "reference only — review before deploying," "not professional advice," acceptable use, the license you grant us to store prompts and publish approved designs to the gallery, indemnification, the AWS third-party trademark note, changes to terms, and a governing-law/venue placeholder. |
| [`privacy-policy.md`](./privacy-policy.md) | The Privacy Policy: what we collect (submitted prompt text, generated designs, IP address, request metadata), why, automated scrubbing, that approved designs may be published to a public gallery, third-party processors (Cloudflare and our third-party AI model provider), retention, and user-rights placeholders. |
| [`disclaimer.md`](./disclaimer.md) | A short, plain-English standalone disclaimer suitable for showing in-product near cost estimates and Terraform downloads. |
| `README.md` | This index. |

## Placeholder checklist (fill before launch)

Every fill-in below appears as a literal `[BRACKETED]` token in the files so you can `grep` for it. Search across this folder for each token and replace it:

- [ ] `[DATE]` — effective date and last-updated date (ToS and Privacy Policy). One value each, or a single launch date.
- [ ] `[STATE]` — governing-law state (ToS §15).
- [ ] `[COUNTY/CITY, STATE]` — exclusive venue for disputes (ToS §15).
- [ ] `[CONTACT EMAIL]` — public contact email for legal/privacy inquiries and gallery-removal requests (ToS §17; Privacy §4, §9, §11, §13).
- [ ] `[ENTITY MAILING ADDRESS]` — S3 Ventures LLC registered/mailing address (ToS §17; Privacy §13).
- [ ] `[RETENTION PERIODS]` — how long Submissions, Generated Output, IP addresses, and request metadata are kept (Privacy §7).
- [ ] `[USER RIGHTS DETAIL]` — jurisdiction-specific rights language (e.g., GDPR/UK GDPR, CCPA/CPRA) (Privacy §11).
- [ ] `[COOKIES DETAIL]` — confirm the actual cookies/similar technologies in use and describe them (Privacy §6).

Grep helper:

```
grep -rnoE '\[[A-Z/ ,]+\]' docs/legal/
```

## Operator/attorney to-do beyond placeholders

- Confirm the entity name (**S3 Ventures LLC**) and the product/domain (**Drafture**, drafture.*) are correct and consistent.
- Decide whether to keep the liability cap at "fees paid or $0" once any paid tier launches, and add billing/refund terms at that time (the ToS is written to allow a paid-tier clause to be added later).
- Confirm the list of third-party processors is complete (currently Cloudflare and the third-party AI model provider) and add a data-processing/subprocessor list if required by applicable law.
- Confirm whether a cookie/consent banner is required for your audience.
- Tailor the user-rights and international-transfer sections to the jurisdictions you actually serve.

## Alternative

A generated policy service such as **Termly** or **iubenda** is an acceptable alternative to hand-drafted documents. If you go that route, keep the product-specific disclaimers (estimates-not-quotes, reference-only, not-professional-advice, AWS-trademark, and the prompt-storage/public-gallery licensing) since off-the-shelf generators typically will not cover them.
