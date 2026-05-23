import pg from 'pg';
import Database from 'better-sqlite3';
import { SQLiteSessionStorage } from '@shopify/shopify-app-session-storage-sqlite';
import { Session } from '@shopify/shopify-api';

let pgPool = null;
let sqliteDb = null;
export let sessionStorage = null;

export async function initDatabase() {
  const dbUrl = process.env.DATABASE_URL || '';

  if (dbUrl.startsWith('postgres')) {
    pgPool = new pg.Pool({
      connectionString: dbUrl,
      ssl: dbUrl.includes('railway') ? { rejectUnauthorized: false } : false,
    });

    await setupPostgresTables();
    sessionStorage = createPostgresSessionStorage();
    console.log('✅ PostgreSQL database ready');
    return;
  }

  sqliteDb = new Database('sessions.db');
  setupSQLiteTables();
  sessionStorage = new SQLiteSessionStorage('sessions.db');
  console.log('✅ SQLite database ready (local dev)');
}

async function setupPostgresTables() {
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS shopify_sessions (
      id TEXT PRIMARY KEY,
      shop TEXT NOT NULL,
      state TEXT,
      is_online BOOLEAN DEFAULT FALSE,
      scope TEXT,
      expires TEXT,
      access_token TEXT,
      online_access_info TEXT
    )
  `);

  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS app_settings (
      shop TEXT PRIMARY KEY,
      settings_json TEXT NOT NULL DEFAULT '{}',
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);
}

function setupSQLiteTables() {
  sqliteDb.exec(`
    CREATE TABLE IF NOT EXISTS app_settings (
      shop TEXT PRIMARY KEY,
      settings_json TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);
}

function createPostgresSessionStorage() {
  return {
    async storeSession(session) {
      await pgPool.query(
        `INSERT INTO shopify_sessions (id, shop, state, is_online, scope, expires, access_token, online_access_info)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (id) DO UPDATE SET
           shop = EXCLUDED.shop,
           state = EXCLUDED.state,
           is_online = EXCLUDED.is_online,
           scope = EXCLUDED.scope,
           expires = EXCLUDED.expires,
           access_token = EXCLUDED.access_token,
           online_access_info = EXCLUDED.online_access_info`,
        [
          session.id,
          session.shop,
          session.state,
          session.isOnline,
          session.scope,
          session.expires ? new Date(session.expires).toISOString() : null,
          session.accessToken,
          session.onlineAccessInfo ? JSON.stringify(session.onlineAccessInfo) : null,
        ]
      );
      return true;
    },

    async loadSession(id) {
      const result = await pgPool.query('SELECT * FROM shopify_sessions WHERE id = $1', [id]);
      if (!result.rows.length) return undefined;

      const row = result.rows[0];
      return new Session({
        id: row.id,
        shop: row.shop,
        state: row.state,
        isOnline: row.is_online,
        scope: row.scope,
        expires: row.expires ? new Date(row.expires) : undefined,
        accessToken: row.access_token,
        onlineAccessInfo: row.online_access_info ? JSON.parse(row.online_access_info) : undefined,
      });
    },

    async deleteSession(id) {
      await pgPool.query('DELETE FROM shopify_sessions WHERE id = $1', [id]);
      return true;
    },

    async deleteSessions(ids) {
      await pgPool.query('DELETE FROM shopify_sessions WHERE id = ANY($1)', [ids]);
      return true;
    },

    async findSessionsByShop(shop) {
      const result = await pgPool.query('SELECT * FROM shopify_sessions WHERE shop = $1', [shop]);
      return result.rows.map(row => new Session({
        id: row.id,
        shop: row.shop,
        state: row.state,
        isOnline: row.is_online,
        scope: row.scope,
        expires: row.expires ? new Date(row.expires) : undefined,
        accessToken: row.access_token,
        onlineAccessInfo: row.online_access_info ? JSON.parse(row.online_access_info) : undefined,
      }));
    },
  };
}

export function getDefaultSettings() {
  return {
    last_query: '',
    selected_product_id: '',
    selected_variant_id: '',
    event_title: '',
    event_subtitle: '',
  };
}

export async function getSettings(shop) {
  if (pgPool) {
    const result = await pgPool.query('SELECT settings_json FROM app_settings WHERE shop = $1', [shop]);
    return result.rows.length
      ? { ...getDefaultSettings(), ...JSON.parse(result.rows[0].settings_json) }
      : getDefaultSettings();
  }

  const row = sqliteDb.prepare('SELECT settings_json FROM app_settings WHERE shop = ?').get(shop);
  return row ? { ...getDefaultSettings(), ...JSON.parse(row.settings_json) } : getDefaultSettings();
}

export async function saveSettings(shop, settings) {
  const json = JSON.stringify(settings);

  if (pgPool) {
    await pgPool.query(
      `INSERT INTO app_settings (shop, settings_json, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (shop) DO UPDATE SET settings_json = EXCLUDED.settings_json, updated_at = NOW()`,
      [shop, json]
    );
    return;
  }

  sqliteDb.prepare(
    `INSERT INTO app_settings (shop, settings_json, updated_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(shop) DO UPDATE SET settings_json = excluded.settings_json, updated_at = datetime('now')`
  ).run(shop, json);
}