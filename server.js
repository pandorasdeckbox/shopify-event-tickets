import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';

import express from 'express';
import dotenv from 'dotenv';
import { ApiVersion, LogSeverity, Session, shopifyApi } from '@shopify/shopify-api';
import '@shopify/shopify-api/adapters/node';

import { getSettings, initDatabase, saveSettings, sessionStorage } from './database.js';
import { buildTicketReport, renderCheckinSheet, searchProducts, toCsv } from './ticketReport.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REQUIRED_ENV = ['SHOPIFY_API_KEY', 'SHOPIFY_API_SECRET', 'APP_URL'];
const missing = REQUIRED_ENV.filter(key => !process.env[key]);

if (missing.length) {
  console.error(`Missing required environment variables: ${missing.join(', ')}`);
  process.exit(1);
}

await initDatabase();

const app = express();
const PORT = Number(process.env.PORT || 3000);
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const oauthStateStorage = new Map();

const shopify = shopifyApi({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET,
  scopes: ['read_products', 'read_all_orders'],
  hostName: process.env.APP_URL.replace(/^https?:\/\//, ''),
  hostScheme: 'https',
  apiVersion: ApiVersion.January25,
  isEmbeddedApp: true,
  sessionStorage,
  logger: {
    level: IS_PRODUCTION ? LogSeverity.Warning : LogSeverity.Debug,
  },
  useOnlineTokens: false,
});

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

if (IS_PRODUCTION) {
  app.set('trust proxy', 1);
}

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/', async (req, res) => {
  const { shop, host } = req.query;
  if (!shop) return res.status(400).send('Missing shop parameter');

  const sanitizedShop = shopify.utils.sanitizeShop(shop);
  if (!sanitizedShop) return res.status(400).send('Invalid shop parameter');

  const session = await sessionStorage.loadSession(`offline_${sanitizedShop}`);
  if (!session) {
    const authUrl = `/auth?shop=${encodeURIComponent(sanitizedShop)}${host ? `&host=${encodeURIComponent(String(host))}` : ''}`;
    return res.send(renderTopRedirect(authUrl));
  }

  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/app', async (req, res) => {
  const { shop, host } = req.query;
  if (!shop) return res.status(400).send('Missing shop parameter');

  const sanitizedShop = shopify.utils.sanitizeShop(shop);
  if (!sanitizedShop) return res.status(400).send('Invalid shop parameter');

  const session = await sessionStorage.loadSession(`offline_${sanitizedShop}`);
  if (!session) {
    const authUrl = `/auth?shop=${encodeURIComponent(sanitizedShop)}${host ? `&host=${encodeURIComponent(String(host))}` : ''}`;
    return res.send(renderTopRedirect(authUrl));
  }

  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/exitiframe', (req, res) => {
  const { shop } = req.query;
  if (!shop) return res.status(400).send('Missing shop parameter');

  const sanitizedShop = shopify.utils.sanitizeShop(shop);
  if (!sanitizedShop) return res.status(400).send('Invalid shop parameter');

  const redirectUri = `https://${sanitizedShop}/admin/apps/${process.env.SHOPIFY_API_KEY}/auth?shop=${encodeURIComponent(sanitizedShop)}`;
  res.send(renderTopRedirect(redirectUri));
});

app.get('/auth', async (req, res) => {
  try {
    const { shop } = req.query;
    if (!shop) return res.status(400).send('Missing shop parameter');

    const sanitizedShop = shopify.utils.sanitizeShop(shop, true);
    if (!sanitizedShop) return res.status(400).send('Invalid shop parameter');

    const state = crypto.randomBytes(16).toString('hex');
    oauthStateStorage.set(sanitizedShop, state);

    const authUrl = `https://${sanitizedShop}/admin/oauth/authorize?` + new URLSearchParams({
      client_id: process.env.SHOPIFY_API_KEY,
      scope: 'read_products,read_all_orders',
      redirect_uri: `${process.env.APP_URL}/auth/callback`,
      state,
    }).toString();

    res.redirect(authUrl);
  } catch (error) {
    res.status(500).send(`Authentication failed: ${error.message}`);
  }
});

app.get('/auth/callback', async (req, res) => {
  try {
    const { shop, code, state } = req.query;
    if (!shop || !code || !state) throw new Error('Missing required OAuth parameters');

    const sanitizedShop = shopify.utils.sanitizeShop(shop, true);
    if (!sanitizedShop) throw new Error('Invalid shop parameter');

    const storedState = oauthStateStorage.get(sanitizedShop);
    if (storedState !== state) throw new Error('Invalid OAuth state parameter');
    oauthStateStorage.delete(sanitizedShop);

    const tokenResponse = await fetch(`https://${sanitizedShop}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: process.env.SHOPIFY_API_KEY,
        client_secret: process.env.SHOPIFY_API_SECRET,
        code,
      }),
    });

    if (!tokenResponse.ok) {
      throw new Error(`Token exchange failed: ${tokenResponse.status} ${await tokenResponse.text()}`);
    }

    const { access_token: accessToken, scope } = await tokenResponse.json();
    const sessionId = `offline_${sanitizedShop}`;
    await sessionStorage.deleteSession(sessionId);

    const session = new Session({
      id: sessionId,
      shop: sanitizedShop,
      state,
      isOnline: false,
      scope,
      accessToken,
    });

    await sessionStorage.storeSession(session);
    res.redirect(`https://${sanitizedShop}/admin/apps/${process.env.SHOPIFY_API_KEY}`);
  } catch (error) {
    res.status(500).send(`Authentication callback failed: ${error.message}`);
  }
});

app.get('/api/shop', withSession(async (req, res) => {
  res.json({ shop: req.shopifySession.shop });
}));

app.get('/api/settings', withSession(async (req, res) => {
  const settings = await getSettings(req.shopifySession.shop);
  res.json({ settings });
}));

app.post('/api/settings', withSession(async (req, res) => {
  const current = await getSettings(req.shopifySession.shop);
  const merged = { ...current, ...req.body.settings };
  await saveSettings(req.shopifySession.shop, merged);
  res.json({ success: true, settings: merged });
}));

app.get('/api/products', withSession(async (req, res) => {
  const query = String(req.query.query || '');
  const products = await searchProducts(req.shopifySession, query);
  res.json({ products });
}));

app.get('/api/report', withSession(async (req, res) => {
  const report = await buildTicketReport(req.shopifySession, {
    productId: req.query.productId,
    variantId: req.query.variantId,
  });

  const current = await getSettings(req.shopifySession.shop);
  const eventTitle = String(req.query.eventTitle || '').trim();
  const eventSubtitle = String(req.query.eventSubtitle || '').trim();

  await saveSettings(req.shopifySession.shop, {
    ...current,
    last_query: String(req.query.search || current.last_query || ''),
    selected_product_id: String(req.query.productId || current.selected_product_id || ''),
    selected_variant_id: String(req.query.variantId || current.selected_variant_id || ''),
    event_title: eventTitle || current.event_title || report.eventTitle,
    event_subtitle: eventSubtitle || current.event_subtitle || report.eventSubtitle,
  });

  res.json(report);
}));

app.get('/api/checkin-sheet', withSession(async (req, res) => {
  const report = await buildTicketReport(req.shopifySession, {
    productId: req.query.productId,
    variantId: req.query.variantId,
  });

  const html = renderCheckinSheet(report, {
    eventTitle: String(req.query.eventTitle || '').trim(),
    eventSubtitle: String(req.query.eventSubtitle || '').trim(),
  });

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
}));

app.get('/api/export/checkin.csv', withSession(async (req, res) => {
  const report = await buildTicketReport(req.shopifySession, {
    productId: req.query.productId,
    variantId: req.query.variantId,
  });

  const title = String(req.query.eventTitle || report.eventTitle || 'event-checkin')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '') || 'event-checkin';

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${title}.csv"`);
  res.send(toCsv(report.rows));
}));

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({ error: error.message || 'Unexpected server error' });
});

app.listen(PORT, () => {
  console.log(`Shopify event tickets listening on port ${PORT}`);
  console.log(`Open ${process.env.APP_URL}/auth?shop=your-store.myshopify.com to install`);
});

function renderTopRedirect(url) {
  return `<!DOCTYPE html><html><head><script>window.top.location.href=${JSON.stringify(url)};<\/script></head><body>Redirecting...</body></html>`;
}

function withSession(handler) {
  return async (req, res, next) => {
    try {
      const rawShop = req.query.shop || req.body?.shop;
      if (!rawShop) {
        return res.status(401).json({ error: 'Missing shop parameter', needsReauth: true });
      }

      const shop = shopify.utils.sanitizeShop(rawShop);
      if (!shop) {
        return res.status(401).json({ error: 'Invalid shop parameter', needsReauth: true });
      }

      const session = await sessionStorage.loadSession(`offline_${shop}`);
      if (!session) {
        return res.status(401).json({
          error: 'No session found',
          needsReauth: true,
          authUrl: `/auth?shop=${encodeURIComponent(shop)}`,
        });
      }

      req.shopifySession = session;
      req.shop = shop;
      await handler(req, res, next);
    } catch (error) {
      next(error);
    }
  };
}