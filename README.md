# KnowFlow AI Study Workspace

A responsive study workspace with private user accounts, a searchable notes library, saved preferences, and persistent study chat. The React frontend talks to a small Node.js API; user data is stored locally in `data/store.json` and partitioned by account.

## Requirements

- Node.js 22 or newer
- npm

## Run locally

1. Install dependencies:

   ```sh
   npm install
   ```

2. Optional: copy `.env.example` to `.env` and set `OPENAI_API_KEY` to enable generated responses. The OpenAI-compatible endpoint and model can be changed with `OPENAI_BASE_URL` and `OPENAI_MODEL`. Without a key, chat searches your notes and returns matching excerpts; it does not pretend to generate general-purpose AI answers.

3. Start the API in one terminal:

   ```sh
   npm run dev:api
   ```

4. Start Vite in another terminal:

   ```sh
   npm run dev
   ```

5. On the computer, open `http://localhost:5173`. On a phone or another computer connected to the same Wi-Fi, open the **Network** URL printed by Vite (for example, `http://192.168.1.25:5173`), then register an account.

The API listens on port `3001` on all network interfaces by default. Vite proxies `/api` requests to it. User accounts and data persist across API restarts in `data/store.json`. If a device still cannot connect, check that both devices are on the same non-guest Wi-Fi network and that the computer's firewall allows inbound connections to ports `5173` and `3001`.

## Production-style run

Build the frontend and start the API/static server:

```sh
npm run build
npm start
```

Open `http://localhost:3001` on the computer, or use the **Network access** URL printed by the server on another device on the same Wi-Fi. Set `NODE_ENV=production` when deploying behind HTTPS so session cookies are marked `Secure`. The local JSON store is intended for a single-instance deployment; use a managed database and a durable secret/environment configuration for a multi-instance production service.

## Checks

```sh
npm run lint
npm test
npm run build
```

The API test uses a temporary data directory and verifies registration, login, account isolation, notes, settings, chat history, clear chat, and logout.

## API overview

- `POST /api/auth/register`, `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`
- `GET /api/notes`, `POST /api/notes`, `DELETE /api/notes/:id`
- `GET /api/settings`, `PATCH /api/settings`
- `GET /api/chat`, `POST /api/chat`, `DELETE /api/chat`
- `GET /api/health`

Passwords are hashed with Node.js `scrypt`; browser sessions use random opaque tokens stored as hashes and sent in `HttpOnly`, `SameSite=Lax` cookies. The API also applies basic authentication rate limiting and security response headers.
