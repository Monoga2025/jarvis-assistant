# Real Statement Validation Runbook

Synthetic fixtures prove parser rules only; they do not verify actual Nequi or Banco de Occidente PDFs.

1. The account holder downloads three monthly PDFs directly from the bank.
2. If a PDF is password protected, unlock a temporary copy interactively outside Jarvis. Never pass or persist the password in Jarvis.
3. Import one file locally and compare transaction count, opening/closing totals and every ambiguous line against the original.
4. Require 100% agreement for totals and at least 90% categorization before accepting the month.
5. Record sanitized parser gaps as tests. Do not commit real names, account numbers, descriptions or document bytes.
6. Delete source and temporary PDFs after reconciliation. Banco de Occidente files are out of scope until the partner gives explicit consent.