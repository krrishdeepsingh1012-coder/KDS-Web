# KD Hologram — by KD Industries

**One workspace. Every model. Infinite possibilities.**

KD Hologram is a lightweight, single-service AI workspace starter with a responsive interface, local accounts, server-side sessions, TOTP MFA, conversation persistence, streaming chat for OpenAI-compatible APIs, text/Markdown/CSV/JSON uploads, and a role-protected admin API.

## Run locally

Requirements: Node.js 20+ and npm.

```bash
cd kd-hologram
cp .env.example .env
# Set SESSION_SECRET to a random string of 32+ characters and configure ADMIN_EMAIL / ADMIN_PASSWORD.
npm install
npm start
```

Open http://localhost:3000. For production, use a strong unique `SESSION_SECRET`, a strong bootstrap admin password, HTTPS, and keep `.env` out of version control.

## Docker

```bash
cp .env.example .env
# Edit .env before launching.
docker compose up --build -d
```

The named Docker volume stores the SQLite database and sessions. The initial administrator is created only if ADMIN_EMAIL and ADMIN_PASSWORD are set and the email does not already exist.

## Database

- **SQLite:** default, stored at `DATA_DIR/hologram.sqlite`; suitable for a small single-instance deployment.
- **PostgreSQL:** set `DATABASE_URL` to a PostgreSQL connection string. Configure managed backups and TLS for production. Do not run multiple SQLite-backed replicas against a shared network filesystem.

## Connect an AI provider

Set `OPENAI_API_KEY` and optionally `OPENAI_BASE_URL` / `OPENAI_MODEL` in the server environment. The chat API uses the OpenAI-compatible `/chat/completions` streaming protocol; compatible gateways and local model servers can be configured through the base URL. Secrets never belong in browser code. Provider credentials entered through the admin API are stored server-side; deploy with encrypted storage and restricted database access.

## Included API surface

- `GET /api/health`, `GET /api/config`
- `POST /api/auth/login`, `POST /api/auth/register`, `POST /api/auth/logout`
- `POST /api/auth/mfa/setup`, `POST /api/auth/mfa/verify` (TOTP)
- `GET/POST /api/conversations`, `GET /api/conversations/:id/messages`
- `POST /api/chat` (SSE streaming when provider configured; JSON fallback when not)
- `POST/GET /api/uploads` (text, Markdown, CSV, JSON; 8 MB/file)
- `GET /api/tools` (MCP integration status)
- `GET /api/admin/overview`, `POST /api/admin/models`, `PATCH /api/admin/users/:id/role`, `GET /api/admin/audit`

## Roadmap / important boundaries

This is a working starter, **not yet a fully audited enterprise platform**. SSO/OIDC/SAML, full MCP protocol execution, vector search/RAG, PDF/DOCX parsing, granular per-tenant policy enforcement, token-cost metering, subscription/payment integration, provider-specific adapters, rate limiting, CSRF protection, and security testing still need implementation before handling sensitive team data. The current UI is a prototype surface; wire its controls to these APIs for the complete product experience. Do not expose it publicly with default or development secrets.
