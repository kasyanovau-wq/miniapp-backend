// 12-30 Mini App Backend (read-only MVP, with debug + Tilda fallback)
import express from 'express';
import crypto from 'crypto';
import fetch from 'node-fetch';
import dotenv from 'dotenv';
import { google } from 'googleapis';
dotenv.config();

const app = express();
app.use(express.json({ limit: '2mb' }));

// CORS (relax now, tighten later)
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const {
  BOT_TOKEN,
  GOOGLE_SA_BASE64,
  GOOGLE_SHEET_ID,
  TILDA_PUBLIC_KEY,
  TILDA_SECRET_KEY,
  TELEGRAM_VERIFY_OFF,
  PORT = 3000,
} = process.env;

// ---- Telegram verify (bypass with TELEGRAM_VERIFY_OFF=1) ----
function verifyTelegram(initData) {
  if (TELEGRAM_VERIFY_OFF === '1') return; // TEMP bypass while debugging

  const url = new URLSearchParams(initData || '');
  const hash = url.get('hash');
  url.delete('hash');

  const dataCheckString = Array.from(url.keys())
    .sort()
    .map(k => `${k}=${url.get(k)}`)
    .join('\n');

  if (!BOT_TOKEN) throw new Error('Server misconfigured: no BOT_TOKEN');
  const secret = crypto.createHash('sha256').update(BOT_TOKEN).digest();
  const computed = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');

  if (computed !== hash) {
    console.error('[verify] mismatch', {
      gotHash: (hash || '').slice(0, 10),
      wantHash: computed.slice(0, 10),
      tokenFirst8: BOT_TOKEN.slice(0, 8),
      tokenLen: BOT_TOKEN.length,
    });
    throw new Error('Bad Telegram signature');
  }

  const authDate = Number(url.get('auth_date') || '0');
  if (!authDate || Date.now() / 1000 - authDate > 24 * 3600) throw new Error('Auth expired');
}

// ---- Google Sheets helpers ----
function getGoogleAuth() {
  const raw = Buffer.from(GOOGLE_SA_BASE64 || '', 'base64').toString('utf8');
  const json = JSON.parse(raw);
  return new google.auth.JWT(json.client_email, undefined, json.private_key, [
    'https://www.googleapis.com/auth/spreadsheets',
  ]);
}

async function appendUserRow({ id, username, first_name, last_name }) {
  const auth = getGoogleAuth();
  const sheets = google.sheets({ version: 'v4', auth });
  const now = new Date().toISOString();
  await sheets.spreadsheets.values.append({
    spreadsheetId: GOOGLE_SHEET_ID,
    range: 'Users!A1',
    valueInputOption: 'USER_ENTERED',
    requestBody: {
      values: [[String(id), username || '', first_name || '', last_name || '', '', '', now, now]],
    },
  });
}

// Accept both "@name" and "name" in column C (SellerUsername)
async function getProductOwnersBySellerUsername(username) {
  const auth = getGoogleAuth();
  const sheets = google.sheets({ version: 'v4', auth });
  const r = await sheets.spreadsheets.values.get({
    spreadsheetId: GOOGLE_SHEET_ID,
    range: 'ProductOwners!A2:D',
  });
  const rows = r.data.values || [];
  const raw = (username || '').trim().toLowerCase();
  const wantAt = raw.startsWith('@') ? raw : '@' + raw;
  const wantNo = raw.startsWith('@') ? raw.slice(1) : raw;

  return rows
    .filter(x => {
      const cell = ((x[2] || '').trim().toLowerCase());
      return cell === wantAt || cell === wantNo;
    })
    .map(x => ({ SKU: x[0], TildaProductId: x[1] }));
}

// ---- Tilda (robust fetch with fallback host + timeout) ----
async function tildaFetch(path, paramsObj) {
  const body = new URLSearchParams(paramsObj);
  const hosts = ['https://api.tilda.cc', 'https://api.tildacdn.info'];
  let lastErr;
  for (const host of hosts) {
    try {
      const ctl = new AbortController();
      const id = setTimeout(() => ctl.abort(), 10000);
      const res = await fetch(`${host}${path}`, { method: 'POST', body, signal: ctl.signal });
      clearTimeout(id);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json().catch(() => ({}));
      return json;
    } catch (e) {
      lastErr = e;
      // try next host
    }
  }
  throw new Error(`Tilda request failed: ${String(lastErr)}`);
}

async function tildaGetOrders() {
  const json = await tildaFetch('/v2/shop/orders/list', {
    publickey: TILDA_PUBLIC_KEY || '',
    secretkey: TILDA_SECRET_KEY || '',
  });
  return json?.result?.orders || [];
}

async function tildaGetProduct(productId) {
  const json = await tildaFetch('/v2/shop/product/get', {
    publickey: TILDA_PUBLIC_KEY || '',
    secretkey: TILDA_SECRET_KEY || '',
    productid: String(productId),
  });
  return json?.result || null;
}

// ---- Routes ----
app.post('/api/me', async (req, res) => {
  try {
    const { initData, initDataUnsafe } = req.body || {};
    verifyTelegram(initData);
    const u = initDataUnsafe?.user || {};
    if (GOOGLE_SHEET_ID && GOOGLE_SA_BASE64) await appendUserRow(u);
    res.json({ ok: true, user: { id: u.id, username: u.username } });
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});

app.post('/api/me/orders', async (req, res) => {
  try {
    const { initData, initDataUnsafe } = req.body || {};
    verifyTelegram(initData);
    const u = initDataUnsafe?.user || {};
    const username = (u.username || '').toLowerCase();
    if (!username) return res.json({ orders: [] });

    const orders = await tildaGetOrders();
    const mine = (orders || []).filter(o => {
      const hay = [
        o.email,
        o.phone,
        o.name,
        o.address,
        o.comment,
        o.payment_comment,
        o.delivery_comment,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return hay.includes('@' + username) || hay.includes(username);
    });

    res.json({ orders: mine });
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});

app.post('/api/me/sales', async (req, res) => {
  try {
    const { initData, initDataUnsafe } = req.body || {};
    verifyTelegram(initData);
    const u = initDataUnsafe?.user || {};
    const links = await getProductOwnersBySellerUsername(u.username || '');
    const out = [];
    for (const link of links) {
      const p = await tildaGetProduct(link.TildaProductId);
      if (p) {
        out.push({
          sku: link.SKU,
          tildaId: link.TildaProductId,
          title: p.title,
          price: p.price,
          images: p.images || [],
        });
      }
    }
    res.json({ products: out });
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});

// ---- Debug routes (remove once green) ----
app.get('/debug/owners', async (req, res) => {
  try {
    const u = (req.query.u || '').toString();
    const links = await getProductOwnersBySellerUsername(u);
    res.json({ username: u, links });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.get('/debug/tildaProduct', async (req, res) => {
  try {
    const id = req.query.id;
    const p = await tildaGetProduct(id);
    res.json({ id, ok: !!p, product: p });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.get('/', (_req, res) => res.send('12-30 backend OK'));
app.listen(PORT, () => console.log('Backend on :' + PORT));
