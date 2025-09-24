// 12-30 Mini App Backend (read-only MVP)
import express from 'express';
import crypto from 'crypto';
import fetch from 'node-fetch';
import dotenv from 'dotenv';
import { google } from 'googleapis';
dotenv.config();

const app = express();
app.use(express.json({ limit: '2mb' }));

// --- CORS (tighten to your Vercel domain later) ---
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*'); // set to your *.vercel.app later
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

// --- Telegram WebApp verify (toggle with TELEGRAM_VERIFY_OFF=1) ---
function verifyTelegram(initData) {
  if (TELEGRAM_VERIFY_OFF === '1') return; // TEMP bypass

  const url = new URLSearchParams(initData || '');
  const hash = url.get('hash');
  url.delete('hash');

  const dataCheckString = Array.from(url.keys())
    .sort()
    .map((k) => `${k}=${url.get(k)}`)
    .join('\n');

  if (!BOT_TOKEN) {
    console.error('[verify] missing BOT_TOKEN');
    throw new Error('Server misconfigured: no BOT_TOKEN');
  }
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

// --- Google Sheets helpers ---
function getGoogleAuth() {
  const raw = Buffer.from(GOOGLE_SA_BASE64 || '', 'base64').toString('utf8');
  const json = JSON.parse(raw);
  return new google.auth.JWT(
    json.client_email,
    undefined,
    json.private_key,
    ['https://www.googleapis.com/auth/spreadsheets']
  );
}

async function appendUserRow({ id, username, first_name, last_name }) {
  const auth = getGoogleAuth();
  const sheets = google.sheets({ version: 'v4', auth });
  const now = new Date().toISOString();
  return sheets.spreadsheets.values.append({
    spreadsheetId: GOOGLE_SHEET_ID,
    range: 'Users!A1',
    valueInputOption: 'USER_ENTERED',
    requestBody: {
      values: [[String(id), username || '', first_name || '', last_name || '', '', '', now, now]],
    },
  });
}

// SellerUsername mapping (column C)
async function getProductOwnersBySellerUsername(username) {
  const auth = getGoogleAuth();
  const sheets = google.sheets({ version: 'v4', auth });
  const r = await sheets.spreadsheets.values.get({
    spreadsheetId: GOOGLE_SHEET_ID,
    range: 'ProductOwners!A2:D',
  });
  const rows = r.data.values || [];
  const want = (username?.startsWith('@') ? username : '@' + username).toLowerCase();
  return rows
    .filter((x) => ((x[2] || '').toLowerCase() === want))
    .map((x) => ({ SKU: x[0], TildaProductId: x[1] }));
}

// --- Tilda (read-only) ---
async function tildaGetOrders() {
  const params = new URLSearchParams({
    publickey: TILDA_PUBLIC_KEY || '',
    secretkey: TILDA_SECRET_KEY || '',
  });
  const res = await fetch('https://api.tilda.cc/v2/shop/orders/list', { method: 'POST', body: params });
  const json = await res.json().catch(() => ({}));
  return json?.result?.orders || [];
}

async function tildaGetProduct(productId) {
  const params = new URLSearchParams({
    publickey: TILDA_PUBLIC_KEY || '',
    secretkey: TILDA_SECRET_KEY || '',
    productid: String(productId),
  });
  const res = await fetch('https://api.tilda.cc/v2/shop/product/get', { method: 'POST', body: params });
  const json = await res.json().catch(() => ({}));
  return json?.result || null;
}

// --- Routes ---
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
    const mine = (orders || []).filter((o) => {
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

app.get('/', (_req, res) => res.send('12-30 backend OK'));
app.listen(PORT, () => console.log('Backend on :' + PORT));
