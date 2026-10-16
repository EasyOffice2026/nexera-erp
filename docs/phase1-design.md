# Phase 1 — Accounting Platform + Qayd XBRL (design for approval)

New standalone, multi-tenant SaaS repo. It receives business events from the POS (your developer's `POS_System`), the website/WhatsApp ordering (`Mudawwrah-website`, `mudawwarah-voice-agent`) and the current Mudawwarah operations system, and turns them into a double-entry ledger, IFRS statements and the XBRL file for the Ministry of Commerce (Qayd).

---

## 1. Tenancy and structure

```
Tenant (subscribing customer / group)
 └─ Company  = legal entity (Commercial Registration no., financial year, KWD, IFRS) → one Qayd filing each
     └─ Brand
         └─ Branch  (= cost centre)
```

Every amount carries company + brand + branch, so statements can be produced per company (for Qayd) and analysed per brand/branch (management).

## 2. Chart of accounts (IFRS template for Kuwaiti F&B, editable per tenant)

| Code | Group              | Examples                                                                                                                                                                                                                                                                                        |
| ---- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1xxx | Assets             | Cash on hand (per branch cash box), Banks (per payment channel), KNET/Link/Talabat/Keeta receivables, Inventory (food, packaging), Prepaid rent & licences, Staff advances/loans, Fixed assets (kitchen equipment, fit-out, vehicles) & accumulated depreciation, Right-of-use assets (IFRS 16) |
| 2xxx | Liabilities        | Suppliers (AP), Accrued expenses, Salaries payable, End-of-service provision, Lease liabilities, Customer advances / gift cards / loyalty points, Due to related parties                                                                                                                        |
| 3xxx | Equity             | Capital, Statutory reserve, Retained earnings, Current-year profit, Owner current account                                                                                                                                                                                                       |
| 4xxx | Revenue            | Food & beverage sales by channel (dine-in, takeaway, delivery, aggregator, website, WhatsApp), Discounts & refunds (contra), Other income                                                                                                                                                       |
| 5xxx | Cost of sales      | Food cost, Packaging, Stock variance & waste, Aggregator commissions                                                                                                                                                                                                                            |
| 6xxx | Operating expenses | Salaries & benefits, EOSB expense, Rent/lease, Utilities, Licence & government renewals, Marketing, Repairs, Bank & KNET fees, Depreciation                                                                                                                                                     |

Each account carries its **IFRS taxonomy concept** (e.g. `ifrs-full:CashAndCashEquivalents`), which is what the XBRL export uses.

## 3. Ledger engine

- Double-entry journals; posted entries are immutable (corrections = reversal + new entry), full audit trail.
- Accounting periods: open / soft-closed / closed; year-end close moves profit to retained earnings and statutory reserve.
- **Posting rules engine:** each incoming event type maps to debit/credit accounts via a configurable table (no code change for a new tenant).
- Inter-branch / central-kitchen transfers post through inventory accounts per branch (no double counting of central purchases).

## 4. Integration API (for the POS developer and other sources)

REST + API key per source system, **idempotency key on every event** (an event sent twice is posted once — same principle the POS already uses for payments/refunds), plus a webhook back with the journal number.

| Event                                                                                     | Typical posting                                                                           |
| ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `sales.day_closed` (per branch/day, by payment method, discounts, refunds, delivery fees) | Dr Cash box / KNET receivable / Aggregator receivable · Cr Sales by channel; Dr Discounts |
| `sales.cost` (recipe cost of items sold, from POS recipes)                                | Dr Food cost · Cr Inventory                                                               |
| `refund.created`                                                                          | Dr Refunds · Cr Cash / receivable                                                         |
| `proceeds.settled` (KNET/Talabat payout with commission)                                  | Dr Bank · Dr Commission · Cr Receivable                                                   |
| `goods.received` / `supplier.invoice` / `supplier.payment`                                | Dr Inventory · Cr AP / Dr AP · Cr Bank                                                    |
| `stock.count` / `stock.waste`                                                             | Dr/Cr Stock variance · Inventory                                                          |
| `expense.paid`, `payroll.posted`, `loan.issued`, `renewal.paid`                           | Dr Expense/Payroll/Advance · Cr Cash/Bank                                                 |
| `cash.transfer` (petty cash, bank deposit)                                                | Dr Cash box · Cr Bank (or reverse)                                                        |

POS_System already has orders, payments, refunds, shifts, recipes, goods receipt and stock counts → each maps directly to an event above. Mudawwarah's current system gets a connector that sends the same events, so Mudawwarah has a full ledger before switching systems.

## 5. Phase 1 modules

1. Tenants, companies, brands, branches, users, roles (owner, finance manager, accountant, auditor read-only), Arabic/English + RTL.
2. Chart of accounts + IFRS concept mapping; opening balances import (from last audited balance sheet, Excel).
3. Ledger, manual journals with attachments & approval, recurring journals.
4. Integration API + posting rules + event log (received / posted / rejected with reason).
5. Receivables (KNET, Link, aggregators, corporate customers) and payables (suppliers) with ageing.
6. Banks & cash: accounts, statement import (Excel/CSV), reconciliation.
7. Fixed assets & depreciation; IFRS 16 leases (branch rents); end-of-service provision (Kuwait Labour Law); accruals/prepayments.
8. Reports: trial balance, general ledger, Balance Sheet, Income Statement, Cash Flow (indirect), Changes in Equity, notes schedules — per company / brand / branch, Excel + Arabic/English PDF.
9. Period close checklist; auditor access + audit pack.

## 6. XBRL / Qayd

- Generator builds the XBRL instance (contexts per period, KWD units, facts per taxonomy concept) from the closed-year statements.
- Validation before upload: balance checks (to the fils), taxonomy validation with Arelle (open-source XBRL processor).
- Until MOCI publishes the final Qayd taxonomy, built and tested against the **IFRS Accounting Taxonomy**; final mapping switched to Qayd's when released. Tested on the Qayd portal during the 2026 voluntary window if access allows.
- Output: XBRL file + human-readable PDF + mapping report for the auditor to sign.

## 7. Technology

PostgreSQL (multi-tenant, row-level tenant isolation) · Python FastAPI or TypeScript/Node (see decision) · React + TypeScript frontend · Docker deploy (Fly.io).

## 8. Milestones

| #   | Deliverable                                                                                    |
| --- | ---------------------------------------------------------------------------------------------- |
| M1  | Repo, tenancy, auth/roles, chart of accounts template, ledger + manual journals, trial balance |
| M2  | Integration API + posting rules; Mudawwarah connector; POS event spec handed to your developer |
| M3  | AR/AP, banks & reconciliation, fixed assets, EOSB, leases, accruals, period close              |
| M4  | IFRS statements + auditor pack (Excel/PDF AR/EN)                                               |
| M5  | XBRL generator + validation; Qayd taxonomy mapping when published                              |
