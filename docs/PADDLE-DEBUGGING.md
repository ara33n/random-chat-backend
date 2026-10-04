# Checkout diagnostics and safe retries

## Confirmed findings

The old handler mapped every exception to 502 without logging. A failed transaction attempt left a `pending` record with no transaction ID. Subsequent attempts inserted the same unique `banId` and failed locally. A production read confirmed this incomplete-record shape for the reported ban; the first upstream failure was not logged and cannot be determined retroactively from that record.

No Render API key is available in the local workspace. Live Paddle transaction creation has not been verified. Do not interpret mocked test success as a successful Paddle checkout.

## Render configuration and diagnosis

Keep `PADDLE_ENVIRONMENT=sandbox`, `PADDLE_API_KEY`, `PADDLE_WEBHOOK_SECRET`, `PADDLE_UNBAN_PRICE_ID`. Do not paste secret values into logs, source or support messages. Price IDs must match `^pri_[a-z0-9]{26}$`.

The API key needs **price.read**, **transaction.write**, and **transaction.read** for reconciliation. All values must belong to the same sandbox account. The frontend must use that account's sandbox client token and the same price.

After deploying, the `[Paddle] configuration` startup line contains only environment and configuration booleans. In Render Shell run:

```
node scripts/check-paddle.js
```

This is read-only: it checks the configured price using the configured API key and environment, including active/one-time status. It never prints the key, price value or webhook secret. It does not prove transaction-write permission or default payment link configuration.

A checkout failure now produces a `[Paddle]` structured log containing operation, environment, safe HTTP/transport error code, Paddle error code and request ID when available. Raw messages, request/config objects, headers and response details are intentionally omitted because they may contain secrets or customer input. Public responses contain a stable diagnostic code only.

- `checkout.price_lookup`: invalid/unauthorized key, missing price.read, wrong account/environment, missing or inaccessible price.
- `checkout.transaction_create`: transaction.write permission, Paddle validation, checkout settings, or upstream availability.
- `checkout.transaction_save` / `checkout.database`: backend persistence issue.
- `transaction_default_checkout_url_not_set`: set **Checkout → Checkout settings → Default payment link** in the Sandbox dashboard (e.g. the site homepage), then retry. This is a possible cause, not a confirmed diagnosis of the original failure.

`Paddle-Version: 1` is valid and retained to pin the documented API version. Requests explicitly use JSON, Bearer authentication, the correct sandbox/live host, a 15-second timeout, and no redirects.

## Retry and recovery behavior

One unique database intent per ban is claimed atomically. Concurrent requests cannot both create a Paddle transaction. Existing matching-environment transactions are reused.

Pre-POST failures and explicit Paddle JSON 4xx rejections (except 408) become `failed` and may retry the same intent. Timeouts, 5xx, malformed success responses, save failures after POST, old orphan records, or interrupted creates become `unknown`/require reconciliation. These must never be deleted or blindly retried: a remote transaction may exist. A process crash can leave `creating`; after 60 seconds the next request marks it unknown without issuing another POST. Existing legacy transaction records with no environment also require reconciliation.

Find the matching transaction in the correct Paddle account using its custom_data.order_id. Supply `PADDLE_RECONCILE_ORDER_ID` and `PADDLE_RECONCILE_TRANSACTION_ID` privately in Render Shell, then run:

```
node scripts/reconcile-paddle.js
```

The script GETs and verifies transaction ID, exact order, one-time price, quantity and environment before attaching it to the original intent. It does not create a payment or unban anyone. For completed transactions resend the original transaction.completed notification from Paddle. If no remote transaction can be confidently found, leave the attempt unresolved and allow the temporary ban to expire; do not create a second charge. Never reset a record merely because an API response timed out.

## Sandbox end-to-end checklist

1. Deploy this backend; verify safe startup diagnostics and run the read-only check above.
2. Set the Sandbox default payment link and configure notification URL `https://strangtexx.onrender.com/api/paddle/webhook` with transaction.completed, API version 1 and its destination secret.
3. Use a fresh test ban; older orphan attempts intentionally require reconciliation. Click Pay once and inspect the safe response code/log if it fails.
4. Expect checkout HTTP 200 containing order/transaction/price IDs. Clicking again must reuse the same transaction.
5. Complete Sandbox checkout using Paddle's documented test card `4242 4242 4242 4242`, a future expiry and security code `100` (no real card).
6. Verify notification HTTP 200, completed payment record/amount in admin, and only the referenced ban closed. Frontend checkout completion alone never unbans.
7. Resend the same signed notification; verify no duplicate payment and no newer ban removed. Wrong environment, altered payload or mismatched transaction/price must be rejected.
8. Check cancellation, timeout and delayed notification paths. Do not pay again to resolve an uncertain transaction.

Sources:
- https://developer.paddle.com/api-reference/about/
- https://developer.paddle.com/api-reference/about/versioning/
- https://developer.paddle.com/api-reference/prices/get-price/
- https://developer.paddle.com/api-reference/transactions/create-transaction/
- https://developer.paddle.com/sdks/libraries/
- https://developer.paddle.com/errors/transactions/transaction_default_checkout_url_not_set/
- https://developer.paddle.com/get-started/quickstart/

## Environment validation correction

Previously `missingPaddleSettings()` tested the raw (untrimmed) price ID against the correct 30-character Paddle format and classified every regex failure as missing. A valid ID surrounded by whitespace therefore returned a misleading missing error. The local reproduction proves this path; the exact Render value is unavailable locally, so whitespace in Render itself is not confirmed.

All Paddle environment reads now use normalized settings: outer whitespace is trimmed, internal characters/quotes are never silently removed, and the same normalized price is used for validation, lookup, transaction creation and persistence. Sandbox remains the default when environment is unset/blank. Invalid nonempty environment names are rejected separately. API keys and webhook secrets are normalized consistently; if a previous ban reference was signed with a whitespace-padded secret, reconnect to obtain a fresh reference after deployment.

- Absent/blank required value: `PADDLE_CONFIGURATION_MISSING`, with names in `missing`.
- Present but malformed price: `PADDLE_PRICE_ID_INVALID`, with names in `invalid`, never `missing`.
- Invalid environment name: `PADDLE_ENVIRONMENT_INVALID`.
- Valid configured price rejected by Paddle: `PADDLE_PRICE_LOOKUP_FAILED` (502), never `missing`.

Safe diagnostics include `hasUnbanPriceId`, `priceIdStartsWithPri`, trimmed `priceIdLength`, `priceIdFormatValid` and `priceIdWhitespaceTrimmed`. No full price ID or credentials are printed. A valid unpadded price has length 30. These diagnostics distinguish actual whitespace from an incorrect/quoted value or configuration not loaded by the deployed process.
