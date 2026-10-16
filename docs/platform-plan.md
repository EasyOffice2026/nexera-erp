# Unified Restaurant Platform — Architecture & Phased Plan (draft for approval)

One product: **POS + Operations + Accounting + Online/WhatsApp ordering + AI Calling Agent + CCTV + Qayd XBRL**.
Nothing is built yet. This document is for confirming direction.

---

## 1. Core idea: one order hub, one ledger

```
 Sales channels                     Core                          Back office
 ──────────────                     ────                          ───────────
 POS (branch till)  ─┐                                       ┌─> Inventory / recipes (stock deduction)
 Website ordering   ─┤                                       ├─> Kitchen display / printers
 WhatsApp ordering  ─┼──>  ORDER HUB  ──> Payment ───────────┼─> Cash box / Payment channels
 AI Calling Agent   ─┤   (one order model,                   ├─> Sales Proceeds (aggregator dues)
 Talabat/Keeta/...  ─┘    one customer record)               └─> GENERAL LEDGER (auto journal)
                                                                          │
 Operations (purchases, central kitchen, transfers, expenses,             ▼
 payroll, renewals, contracts) ──────────── auto journal ──────> Trial balance → IFRS statements
                                                                          │
 CCTV events (linked to POS voids, refunds, drawer opens) ── audit        ▼
                                                                  XBRL file for Qayd (MOCI)
```

Every module writes business events; the ledger posts them automatically. Nobody keys journal entries twice.

## 2. Modules

| #   | Module                           | Content                                                                                                                                                                                                                                                                                                                                            |
| --- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Core platform**                | Companies (each Commercial Registration = one legal entity / one XBRL filing), brands, branches, users, roles & permissions, Arabic/English + RTL, attachments, audit log, approvals, notifications. Multi-tenant so it can be sold to other businesses.                                                                                           |
| 2   | **POS**                          | Touch till (PWA, works offline and syncs), menu with modifiers/combos, dine-in/takeaway/delivery, split payments (cash, KNET, link), receipts on 80mm printers, shifts with X/Z reports, voids/refunds with reasons, kitchen display. Replaces daily manual sales entry: Z-report fills the daily sales automatically.                             |
| 3   | **Menu, inventory & recipes**    | Products → recipes (ingredients per item), stock per branch and central kitchen, automatic consumption from sales, waste, stock counts, food-cost %.                                                                                                                                                                                               |
| 4   | **Operations** (from Mudawwarah) | Central & branch purchases, suppliers & ledgers, internal transfers, cash boxes, payment channels, sales proceeds, expenses, contracts, HR/payroll, loans, renewals, Personnel & Purchase offices.                                                                                                                                                 |
| 5   | **Accounting**                   | IFRS chart of accounts, auto-posting from all modules, manual journals, AP/AR, bank reconciliation, fixed assets & depreciation, end-of-service provision, accruals/prepayments, period close, cost centres per branch/brand. Reports: trial balance, Balance Sheet, Income Statement, Cash Flow, Changes in Equity, per company and consolidated. |
| 6   | **XBRL / Qayd**                  | Map accounts to the MOCI taxonomy, generate XBRL instance, validate (Arelle) before upload, auditor-review pack (Arabic/English PDF + Excel). Final tags depend on MOCI publishing the taxonomy.                                                                                                                                                   |
| 7   | **Website ordering**             | Brand website + online menu, cart, delivery zones/fees, pickup, online payment (Tap/MyFatoorah/KNET), order tracking. Orders land in the same hub as POS.                                                                                                                                                                                          |
| 8   | **WhatsApp ordering**            | WhatsApp Business Cloud API: menu browsing, cart, payment link, order status messages, reorder. Same hub, same customer record.                                                                                                                                                                                                                    |
| 9   | **AI Calling Agent**             | Phone line answered by an AI voice agent (Arabic Kuwaiti dialect + English): takes orders, answers menu/branch questions, checks order status, hands over to a human. Needs a telephony provider (local SIP trunk or Twilio-type). Calls recorded and transcribed.                                                                                 |
| 10  | **CCTV data management**         | Connect branch NVRs/cameras (ONVIF/RTSP; e.g. Hikvision/Dahua). Index footage by time and link it to POS events: click a void, refund, discount or drawer-open and see the clip. Camera health monitoring, retention rules; optional AI analytics later (people counting, queue length).                                                           |
| 11  | **Customers & loyalty / CRM**    | One customer profile across POS, web, WhatsApp, phone; addresses, order history, points, campaigns.                                                                                                                                                                                                                                                |
| 12  | **Aggregators**                  | Talabat / Keeta / Jahez / Snoonu: orders and settlements flow into Sales Proceeds automatically where APIs allow.                                                                                                                                                                                                                                  |
| 13  | **Dashboards & reports**         | Owner dashboard, branch performance, food cost, cash variance, Excel/PDF everywhere.                                                                                                                                                                                                                                                               |

## 3. Technology

- **Backend:** Python FastAPI (same as today) — modular, one service per domain inside one codebase.
- **Database:** **PostgreSQL** (multi-tenant, concurrency, reporting). The current SQLite is not suitable for POS volume and multiple customers.
- **Frontend:** React + TypeScript (same as today); POS as installable PWA with offline queue.
- **Integrations:** WhatsApp Cloud API, payment gateway, telephony + speech AI, NVR/ONVIF, XBRL validator.
- **Hosting:** cloud (Fly.io/AWS) + a small local "branch agent" for printers, cash drawer and CCTV streams.

## 4. Phases (suggested order)

| Phase | Deliverable                                                                  | Why first                                                      |
| ----- | ---------------------------------------------------------------------------- | -------------------------------------------------------------- |
| 1     | Core platform + **Accounting GL** with auto-posting from existing operations | Needed for audited IFRS statements and the 2027 Qayd mandate.  |
| 2     | **XBRL export** + auditor pack; test on Qayd during the voluntary window     | Mandatory from 1 Jan 2027; filing within 6 months of year-end. |
| 3     | **POS** + menu/recipes/inventory                                             | Replaces Foodics/manual daily sales; feeds ledger directly.    |
| 4     | **Website + WhatsApp ordering** (order hub, customers)                       | Reuse POS menu and order model.                                |
| 5     | **AI Calling Agent**                                                         | Builds on order hub + customer records.                        |
| 6     | **CCTV** link to POS events                                                  | Needs POS events to link to.                                   |
| 7     | Aggregator APIs, loyalty, AI analytics                                       | Enhancements.                                                  |

Mudawwarah keeps running on the current system; it moves to the new product once POS + Accounting are ready (data migrated).

## 5. Decisions needed

1. **Repository:** new standalone product repo (recommended, keeps Mudawwarah's live system safe) vs. growing `accounting-saas`. Product name?
2. **Audience:** in-house (Mudawwarah, Khubuz Maraei) only, or sold to other restaurants (multi-tenant SaaS, subscriptions)?
3. **Legal entities:** are Mudawwarah and Khubuz Maraei separate CRs? Financial year-end? Auditor?
4. **POS vs Foodics:** replace Foodics fully? Hardware in branches (terminals, 80mm printers, cash drawers, KDS screens)?
5. **Payment gateway:** Tap, MyFatoorah, or other?
6. **WhatsApp:** existing WhatsApp Business account/number per brand?
7. **Calling agent:** current phone setup (mobile numbers, landline, call-centre system)?
8. **CCTV:** camera/NVR brand per branch and whether NVRs are reachable over the internet.
9. **Phase order:** OK to start with Accounting + XBRL, or POS first?
