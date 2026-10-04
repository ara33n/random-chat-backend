# Administrator access and records

Administrator login is verified by the backend. Passwords are case-sensitive and spaces count. Never put passwords in frontend configuration or commit an environment file.

To provision/reset an administrator, supply `ADMIN_SETUP_USER` and `ADMIN_SETUP_PASSWORD` privately as environment variables, then run `node scripts/set-admin.js` against the intended `MONGO_URI`. The script saves a salted scrypt hash, not a plaintext password. It creates no public bootstrap/reset endpoint. Deploy the updated backend before signing in. For a provisioned username, database credentials override the legacy `ADMIN_USER`/`ADMIN_PASS` pair. Existing environment credentials still work for other usernames; remove obsolete environment credentials after migration. `ADMIN_TOKEN` remains an optional server-controlled operator credential.

Reports contain server-derived reporter/accused IPs and approximate city/region/country from the local GeoIP database. Missing locations show Unknown. VPNs, proxies, shared IPs and database age affect accuracy; location is not proof of identity. Older records are enriched at read time when possible.

Bans and reports are separate sections. Active-only bans exclude expired restrictions.

The successful-payments endpoint is administrator-only and returns the latest 500 completed records. Amounts come from the signed, matching Paddle transaction.completed webhook (`details.totals.grand_total`, in minor units, with `currency_code`). Currency formatting follows currency decimal precision. Order, transaction and exact ban reference identify anonymous payers alongside their IP. No card information is stored. Sandbox transactions are labeled as tests. Historical records without amounts/environment show Not recorded/Unknown; no amounts are invented. Refunds and chargebacks are not synchronized by this view.

Webhook documentation: https://developer.paddle.com/webhooks/transactions/transaction-completed/
