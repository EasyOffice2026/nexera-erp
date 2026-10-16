# Handover: nexera-erp

Start here when continuing this project in a new Devin session.

## What this is

A new, standalone, **multi-tenant SaaS** for restaurant groups (sold to other restaurants too):
accounting linked to everything + the Kuwait Ministry of Commerce **Qayd XBRL** filing.
It is completely separate from the live Mudawwarah system (`EasyOffice2026/accounting-saas`,
https://mudawwarah.nexerakw.com/). Do not change that system or its database from this project.

- Full product plan: `docs/platform-plan.md`
- Phase 1 design (approved direction): `docs/phase1-design.md`

## Decisions already taken by the owner (Javed)

| Topic                      | Decision                                                                                                                                                                                                                                          |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Repo                       | New standalone repo `EasyOffice2026/nexera-erp`                                                                                                                                                                                                   |
| Product                    | Multi-tenant SaaS (tenant → company/legal entity → brand → branch)                                                                                                                                                                                |
| First phase                | Accounting + XBRL                                                                                                                                                                                                                                 |
| Stack                      | TypeScript/Node + PostgreSQL, same conventions as the POS (`EasyOffice2026/POS_System`) so its developer can work on it too: Express 5, Prisma 7 (`@prisma/adapter-pg`), zod 4, jose, vitest, React 19 + Vite + Tailwind 4 + i18next (EN/AR, RTL) |
| Mudawwarah / Khubuz Maraei | **Two separate companies** (two CRs, two Qayd filings), financial year-end **31 Dec**                                                                                                                                                             |
| POS                        | Built by the owner's own developer in `EasyOffice2026/POS_System`. Do not rebuild it; integrate through an events API                                                                                                                             |
| Website                    | Already done (`EasyOffice2026/Mudawwrah-website`); WhatsApp agent in `EasyOffice2026/mudawwarah-voice-agent`. Integrate via API, no shared database                                                                                               |

## Qayd / XBRL facts (researched Oct 2026)

- Portal qayd.moci.gov.kw opened Apr 2026; voluntary in 2026, **mandatory from 1 Jan 2027** for all companies (WLL, single-person, partnership, KSC).
- IFRS statements in XBRL, within 6 months of year-end, signed by a licensed auditor. Fines KD 5,000–50,000.
- Final MOCI taxonomy/technical manual not confirmed published. Build against the IFRS taxonomy with configurable mapping (`Account.taxonomyConcept`), switch to Qayd's when released. Validate with Arelle.

## State of the code (first commit)

Done:

- Monorepo: `apps/api`, `apps/web` (package + Vite config only), `packages/shared`.
- `packages/shared`: zod schemas/types for auth & roles/permissions, companies/brands/branches,
  chart of accounts (types, IFRS subtypes), fiscal years/periods, journals, reports; exact money
  helpers in whole fils (`toFils`/`fromFils`). Unit tests for money, accounts, journal lines.
- `apps/api/prisma/schema.prisma`: tenants, users, refresh tokens, companies, brands, branches,
  accounts (tree + taxonomy concept), fiscal years, periods, journal entries/lines
  (draft/posted, per-company number on posting, reversal link, idempotent
  `(company, source_system, external_id)`), audit log. **No migration generated yet.**
- `apps/api/src`: config, prisma client, password hashing (scrypt), JWT access + rotating refresh
  cookie, audit log helper, money/date helpers, middleware (authenticate, requirePermission,
  error handler, security headers, request log), modules `auth`, `users`, `health`.

Not done yet (milestone M1, in order):

1. `npx prisma migrate dev --name init` (from `apps/api`) to create the first migration.
2. `modules/companies`: CRUD for companies/brands/branches; on create with `useTemplate`, seed the
   IFRS restaurant chart of accounts (see `docs/phase1-design.md` §2) with taxonomy concepts.
3. `modules/accounts`: list as tree, create/update; block deleting/changing type of used accounts.
4. `modules/periods`: create fiscal year (12 monthly periods), close/reopen periods.
5. `modules/journals`: draft create/update/delete; post (≥2 lines, debit = credit in fils, postable
   active accounts and branches of the same company, date in an OPEN period, lock company row
   `SELECT … FOR UPDATE` to assign the next number); reverse (swapped lines, links both entries).
6. `modules/reports`: trial balance (opening / period / closing, filter by branch/brand), account
   ledger with running balance, basic Income Statement and Balance Sheet by subtype.
7. `app.ts` + `server.ts` (mount routers under `/api/v1`, serve `WEB_DIST` in production),
   `prisma/seed.ts` (demo tenant `easyoffice` with companies Mudawwarah and Khubuz Maraei),
   `prisma/create-tenant.ts` CLI.
8. API tests with supertest against a real Postgres schema `nexera_test` (copy the POS
   `test/global-setup.ts` pattern).
9. Web app: login, company switcher, chart of accounts, journals (entry form, post, reverse),
   periods, trial balance, EN/AR with RTL.
10. CI (`.github/workflows/ci.yml`: format, lint, typecheck, test with Postgres service, build),
    README, Dockerfile, then open the PR.

Next milestones after M1: integration API + posting rules (M2), AR/AP, banks, fixed assets,
EOSB, IFRS 16 leases, period close (M3), statements + Excel/Arabic PDF auditor pack (M4),
XBRL generator + validation (M5). See `docs/phase1-design.md` §8.

## Local setup

```bash
nvm use 24            # Node >= 24 required (.nvmrc)
npm install           # also runs prisma generate
npm run infra:up      # Postgres 17 on localhost:5432 (docker-compose.yml)
cp .env.example .env
```

## Still to ask the owner

- Auditor name and last audited financial statements (to match the chart of accounts and
  opening balances).
- Where to deploy (Fly.io like the current system?) and which PostgreSQL provider.
