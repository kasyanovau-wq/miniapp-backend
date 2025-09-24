import express from 'express';
import fetch from 'node-fetch';
import { google } from 'googleapis';

const app = express();
app.use(express.json());

const VERSION = 'r5-debug';

// --- Google Sheets setup ---
const sheetsAuth = new google.auth.GoogleAuth({
  credentials: JSON.parse(
    Buffer.from(process.env.GOOGLE_SA_BASE64, 'base64').toString('utf8')
  ),
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
const sheets = google.sheets({ version: 'v4', auth: sheetsAuth });
const SHEET_ID = process.env.SHEET_ID;

// --- Telegram WebApp verification (can be bypassed) ---
function verifyTelegramPayload(initData) {
  if (process.env.TELEGRAM_VERIFY_OFF === '1') {
    return { ok: true };
  }
  // TODO: proper signature check if re-enabled
  return { ok: false, error: 'Verification disabled but required' };
}

// --- Tilda fetch with fallback host ---
async function tildaFetch(path, paramsObj) {
  const body = new URLSearchParams(paramsObj);
  const hosts = ['https://api.tilda.cc', 'https://api.tildacdn.info'];
  let lastErr;

  for (const host of hosts) {
    try {
      const ctl = new AbortController();
      const id = setTimeout(() => ctl.abort(), 10000); // 10s timeout
      const res = await fetch(`${host}${path}`, { method: 'POST', body, signal: ctl.signal });
      clearTimeout(id);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json().catch(() => ({}));
      return json;
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`Tilda request failed: ${String(lastErr)}`);
}

async function tildaGetOrders() {
  const json = await tildaFetch('/v2/shop/orders/list', {
    publickey: process.env.TILDA_PUBLIC_KEY || '',
    secretkey: process.env.TILDA_SECRET_KEY || '',
  });
  return json?.result?.orders || [];
}

async function tildaGetProduct(productId) {
  const json = await tildaFetch('/v2/shop/product/get', {
    publickey: process.env.TILDA_PUBLIC_KEY || '',
    secretkey: process.env.TILDA_SECRET_KEY || '',
    productid: String(productId),
  });
  return json?.result || null;
}

// --- Sheets helpers ---
async function getProductOwnersBySellerUsername(username) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: 'ProductOwners!A2:D',
  });
  const rows = res.data.values || [];
  return rows
    .filter(r => (r[2] || '').replace('@', '').toLowerCase() === username.replace('@', '').toLowerCase())
    .map(r => ({ SKU: r[0], TildaProductId: r[1], SellerUsername: r[2], Notes: r[3] }));
}

// --- API routes ---
app.post('/api/me', async (req, res) => {
  const { initData, initDataUnsafe } = req.body;
  const verify = verifyTelegramPayload(initData);
  if (!verify.ok) return res.status(403).json({ error: verify.error });

  const user = initDataUnsafe?.user || {};
  // Save/update user in Users sheet
  const now = new Date().toISOString();
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: 'Users!A2',
    valueInputOption: 'RAW',
    requestBody: {
      values: [[
        user.id, user.username, user.first_name, user.last_name,
        user.email || '', user.phone || '', now, now
      ]]
    }
  });
  res.json({ ok: true, user });
});

app.post('/api/me/orders', async (req, res) => {
  const { initData, initDataUnsafe } = req.body;
  const verify = verifyTelegramPayload(initData);
  if (!verify.ok) return res.status(403).json({ error: verify.error });

  try {
    const orders = await tildaGetOrders();
    res.json({ orders });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.post('/api/me/sales', async (req, res) => {
  const { initData, initDataUnsafe } = req.body;
  const verify = verifyTelegramPayload(initData);
  if (!verify.ok) return res.status(403).json({ error: verify.error });

  try {
    const username = (initDataUnsafe?.user?.username || '').replace('@', '');
    const links = await getProductOwnersBySellerUsername(username);
    const products = [];
    for (const link of links) {
      const prod = await tildaGetProduct(link.TildaProductId);
      if (prod) products.push({ ...link, product: prod });
    }
    res.json({ products });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// --- Debug routes ---
app.get('/', (_req, res) => res.send('12-30 backend OK ' + VERSION));

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

// --- Start ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Backend running on ' + PORT));
