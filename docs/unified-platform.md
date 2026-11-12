# Unified restaurant platform (one platform)

Owner's direction (Nov 2026): bring POS, purchases, expenses, payments, HR, documents,
contracts/subscriptions and accounting under **one platform** for multiple brands and branches,
EN/AR, KWD. nexera-erp is the platform; POS_System stays its own repo (owner's developer) and
joins through single sign-on and data sync. No code merge.

## Shape

- One login (nexera-erp). The menu opens every module; "POS" opens the POS back office or till
  through SSO without a second sign-in.
- One setup: brands/branches set up in the ERP; each POS brand/branch is linked to an ERP
  brand/branch (and so to its company).
- One POS deployment (single group, no tenants) = one ERP tenant.

## Phases (one PR each, stacked on PR #6 until the owner merges)

0. Platform shell: grouped menu, POS connection + brand/branch mapping.
1. POS link
   - POS_System PR: integration key (hashed, group admin), read-only `/api/v1/accounting/*`
     (structure, days, goods-receipts, stock-losses), SSO `POST /api/v1/auth/sso` verifying an
     ERP-signed JWT (EdDSA, ERP JWKS at `/api/v1/sso/jwks.json`, aud = POS URL, exp 60s, jti once).
   - ERP pulls (POS runs on Vercel, no background workers) hourly + "Sync now"; stores each
     document (day/grn/loss) idempotently with a payload hash; re-posts by reversal when it
     changes; journals source INTEGRATION, sourceSystem `pos`.
   - Day journal per branch: Dr method account (amount - commission), Dr commission expense,
     Dr discounts, Cr sales (subtotal); refunds Dr sales returns / Cr method; cash over/short;
     COGS Dr cost of sales / Cr inventory. GRN: Dr inventory / Cr AP (party = supplier).
     Waste and count variance vs inventory.
2. Purchases & AP. 3. Expenses & payments. 4. HR & payroll (day rate = salary / 30, EOSB).
3. Documents (expiry alerts). 6. Contracts & subscriptions (expense dated last day of covered
   month, renewal alerts).

## Working notes (code pointers)

- ERP work branch: stack on `devin/1793510000-crm-integration` (PR #6). Tests: `npm test` (58 API + 36 shared pass at start).
- ERP system journals: `postJournalInTx(tx, actor: PostingActor, companyId, {date, description, reference, lines, source:'INTEGRATION', sourceSystem, externalId}, postedAt)` in `apps/api/src/modules/journals/journals.service.ts`; lines may carry `partyId` (SubledgerParty, unique companyId+sourceSystem+externalRef).
- Posting-role defaults pattern: `apps/api/src/modules/platform/crm-defaults.ts` (role -> template code, ensure account exists). Chart template `apps/api/src/modules/companies/chart-template.ts`.
- ERP permissions in `packages/shared/src/auth.ts` (roles owner/finance_manager/accountant/auditor; `integrations.manage`).
- ERP nav: `apps/web/src/app/Layout.tsx` (sections array), routes `apps/web/src/app/routes.tsx`.
- POS: single group (no tenant). Roles in `packages/shared/src/access.ts` (group_admin has all). Print-bridge key auth pattern (`printing.service.ts` hashBridgeKey / `print-bridge.router.ts`). Business date: `businessDateOn(at, tz, dayEndsAt)` in `packages/shared/src/branch-config.ts`. Sales report pattern `apps/api/src/modules/reports/reports.service.ts` (paid orders by businessDate; discounts = discountAmount+promotionDiscount+pointsDiscount; payments groupBy method with commission). POS work branch: `devin/1794487382-erp-link`.
- POS models: Order(subtotal,total,refunded,businessDate,status paid), Payment(method, amount, commission), Refund(method, amount, commission, createdAt), Shift(closedAt, difference), StockMovement(kind sold/waste/count/received, quantity, ingredient.costPerUnit), StockCountLine(unitCost), PurchaseOrder(status received, receivedAt, receivedTotal, invoiceNumber, supplier.paymentDays).
- Restaurant chart codes (restaurant_v1 template): 1110 cash on hand-branches, 1130 bank, 1140 bank-KNET settlement, 1210 KNET receivable, 1220 Link/online, 1230 Talabat, 1240 Keeta, 1250 other aggregators, 1310 food inventory, 2110 suppliers, 4110 dine-in, 4120 takeaway, 4130 own delivery, 4140 aggregators, 4810 discounts, 4820 refunds, 4900 other income, 5110 food cost, 5140 stock variance & waste, 5150 aggregator commissions, 6260 bank/KNET charges.
- POS_System branch `devin/1794487382-erp-link` done: IntegrationKey/SsoRedemption models+migration, `modules/accounting` (structure/days/goods-receipts, keys router at /integration-keys), `/auth/sso` (EdDSA, config SSO_ISSUER/SSO_JWKS_URL/SSO_AUDIENCE), web `/sso` page, spec docs/specs/029-erp-link.md. POS tests use DATABASE_URL=postgresql://pos:pos@localhost:5432/pos (role+db created inside nexera-erp-postgres-1; Docker Hub rate-limited).

## ERP POS module design (decided)

- Tables: PosConnection(tenantId unique, apiUrl, webUrl, keyCiphertext AES-256-GCM via INTEGRATION_ENCRYPTION_KEY, lastSyncAt, lastError); PosBranchLink(tenantId+posBranchId unique, posBrandId, branchId -> ERP Branch => company); PosAccount(companyId+role unique, accountId) roles: sales 4120, discounts 4810, refunds 4820, commission 5150, cash_over_short 6270, cost_of_sales 5110, inventory 1310, waste 5140, payable 2110, method:cash 1110, method:knet 1210, method:talabat 1230, method:keeta 1240, other methods 1250 (defaults looked up by code; missing => document 'unmapped'); PosDocument(companyId+externalId unique, kind day|grn, businessDate, payloadHash, journalEntryId, status posted|unmapped|failed, error).
- Day journal: Dr method (amount-commission) + Dr commission; Dr discounts; Cr sales = payments+discounts; refunds Dr refunds / Cr method net / Cr commission; cash over/short; COGS/waste/count vs inventory. GRN: Dr inventory / Cr payable (party pos supplier). Changed hash => reverse old journal, post new with externalId `<id>:<hash12>`.
- Routes /api/v1/pos: GET/PUT connection, GET structure (proxy+links), PUT branch-links, GET/PUT companies/:id/accounts, POST sync {from,to}, GET documents, POST sso -> {url}. GET /api/v1/sso/jwks.json public. Interval sync POS_SYNC_INTERVAL_MINUTES. SSO: Ed25519 SSO_SIGNING_KEY (PKCS8 PEM), iss=ERP_PUBLIC_URL, aud 'pos', exp 60s, email claim.
- ERP branch `devin/1794488080-pos-link` (stacked on PR #6): written schema+migration 20261112130000_pos_link, lib/secret-box.ts, lib/sso.ts, config (PUBLIC_URL, INTEGRATION_ENCRYPTION_KEY, SSO_PRIVATE_KEY, POS_SSO_AUDIENCE, POS_SYNC_INTERVAL_MINUTES), modules/pos/{pos.service,pos.router}.ts, app.ts wiring (/pos, /sso/jwks.json, posFetch dep), server.ts timer, test helpers reset. Next: typecheck, test/pos.test.ts, web (grouped menu + POS page), commit, PRs.
- ERP POS backend done + test/pos.test.ts (5 pass).
