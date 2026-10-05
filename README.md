# Random Chat Backend (Node.js + Socket.IO)

Signaling + matchmaking server for 1:1 random chats (video+text or text-only).

## Run

```bash
npm install
npm run start
# defaults to http://localhost:3001
```

## Deployment and connection checks

Use Node.js 24 LTS (pinned in `.node-version` and `package.json`). Local `.env` configuration is loaded automatically; host-provided values take precedence.

- `MONGO_URI`: MongoDB connection string, supplied through the host's environment settings.
- Browser origins are fixed to `https://loopchatx.chat`, `https://www.loopchatx.chat`, and local development at `http://localhost:4200` for HTTP and Socket.IO. Other origins, including preview deployments, are rejected. `FRONTEND_ORIGINS` no longer changes this allowlist. No-Origin HTTP requests remain available for Render health checks and signed Paddle webhooks; sockets require an allowed Origin. Origin filtering is not authentication against non-browser clients.
- `PORT`: supplied by Render (defaults to 3001 locally).

Configure the Render health-check path as `/health`. This returns HTTP 200 only when a database ping succeeds, and HTTP 503 otherwise. `/` is only a basic HTTP liveness check and cannot confirm database readiness.

Socket.IO validates bans before accepting each connection. A failed database check returns `DATABASE_UNAVAILABLE` instead of accepting a connection that cannot process events. An initial MongoDB connection failure exits the process so the host can restart it; logs contain the error type without connection credentials.

If MongoDB fails on Render, verify its `MONGO_URI`, Atlas database user, and Atlas Network Access rules for the Render service's outbound IP addresses. A successful local database ping does not prove that Render has the same configuration or network access.

Public Google sign-in endpoints are disabled. Administrator routes remain protected.
