# Approval Ratio Analysis Dashboard

Browser-only Netlify/Vite dashboard for transaction CSV analysis. It does not bundle or upload production transaction data with the project.

## Core approval-ratio logic

The dashboard is retry-safe and counts one checkout outcome per `merchantOrderId`.

1. It groups all attempts for the same `merchantOrderId`.
2. If any PSP attempt is approved, that merchant order is counted once as approved.
3. If no attempt is approved, it is counted once as a declined checkout session. The final decline supplies the reason and hard/soft classification.
4. PSP, country, and MID performance are attributed to the first routed attempt, while the checkout's final outcome determines whether it succeeded.

For the August 20–31 report, this produces 38,843 approved checkout sessions out of 51,409 total checkout sessions: **75.56%**.

## Approval-ratio cohorts

Use the **Approval-ratio denominator** filter to switch analysis views:

| View | Formula |
| --- | --- |
| All terminal declines | Approved ÷ all checkout sessions |
| Hard-decline cohort | Approved ÷ (approved + hard-declined sessions) |
| Soft-decline cohort | Approved ÷ (approved + soft-declined sessions) |

The overview always shows all three, while PSP, country, MID, and trend tables follow the selected cohort.

## Country performance

Each country row includes its highest-performing PSP. The winning PSP is based on the standard final approval ratio for first-routed orders and excludes PSPs below the configurable minimum session count. `NA` is preserved as Namibia.

## Required CSV fields

- `merchantOrderId`
- `status` (`approved` or `declined`)
- `processing_date` (UTC timestamp) or `processingDate` (Unix seconds)

The dashboard also uses `pspName`, `country`, `midAlias`, `declineReason`, `statusReason`, `declineCode`, `amount`, and `email` when available.

## Local development

```bash
npm ci
npm run dev
```

## Netlify deployment

- Build command: `npm run build`
- Publish directory: `dist`
- Node version: `20`

Push this project to a private repository, create a Netlify site from that repository, and deploy. Do not commit transaction reports to the repository.
