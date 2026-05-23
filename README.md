# Shopify Event Tickets

Shopify embedded app for generating printable event ticket check-in sheets directly from Shopify orders.

## What It Does

- Searches your Shopify product catalog for event ticket products and variants
- Pulls matching orders for the selected ticket variant directly from the Admin API
- Aggregates one row per order, keeps ticket quantities intact, and sorts by attendee name
- Opens a print-ready HTML check-in sheet in the same format as your existing manual sheets
- Exports the same buyer list as CSV for backup or spreadsheet use

## Architecture

| Component | Technology |
|-----------|------------|
| Backend | Express.js |
| Frontend | Vanilla JS single-page app |
| Auth | Custom embedded Shopify OAuth with offline tokens |
| Database | PostgreSQL on Railway or SQLite locally |
| Hosting | Railway |

## Files

```text
shopify-event-tickets/
├── server.js
├── database.js
├── ticketReport.js
├── public/
│   └── index.html
├── package.json
├── railway.json
├── Procfile
└── .env.example
```

## Shopify Setup

Create a Shopify app and configure:

1. App URL: `https://your-domain.com/app`
2. Allowed redirection URL: `https://your-domain.com/auth/callback`
3. Admin API scopes:
   - `read_products`
   - `read_orders`

## Railway Setup

1. Push this repo to GitHub.
2. Deploy it on Railway.
3. Add a PostgreSQL service if you want persistent sessions/settings in production.
4. Set these environment variables:

| Variable | Value |
|----------|-------|
| `SHOPIFY_API_KEY` | Shopify app API key |
| `SHOPIFY_API_SECRET` | Shopify app API secret |
| `APP_URL` | Public app origin only, for example `https://event-tools.pandorasdeckbox.com` |
| `DATABASE_URL` | Railway Postgres URL, optional for local-only SQLite |
| `NODE_ENV` | `production` |

## Local Development

```bash
git clone https://github.com/pandorasdeckbox/shopify-event-tickets.git
cd shopify-event-tickets
npm install
cp .env.example .env
```

Then set your Shopify credentials in `.env`.

For local OAuth callbacks, run a tunnel:

```bash
npm run tunnel
```

Set `APP_URL` to the tunnel URL, then start the app:

```bash
npm run dev
```

Install it by visiting:

```text
https://your-app-url/auth?shop=your-store.myshopify.com
```

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check |
| GET | `/auth` | Start OAuth |
| GET | `/auth/callback` | Complete OAuth |
| GET | `/api/products` | Search products and variants |
| GET | `/api/report` | Preview orders for the selected ticket variant |
| GET | `/api/checkin-sheet` | Render printable HTML sheet |
| GET | `/api/export/checkin.csv` | Download CSV export |
| GET | `/api/settings` | Load last-used settings |
| POST | `/api/settings` | Save last-used settings |

## Notes

- The app currently treats cancelled, refunded, and voided orders as excluded from the check-in list.
- `read_orders` is enough for the app to function, but Shopify may limit how far back the app can read orders unless broader historical order access is granted on the store.
- Product search uses Shopify Admin search syntax. Simple title keywords usually work well.
- The printable sheet opens in a separate tab so it can be printed cleanly from the browser.
- Shopify App URL should include `/app`, but `APP_URL` in Railway should be just the origin, without `/app`.