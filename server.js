const express = require('express');
const cors = require('cors');
const http = require('http');
const morgan = require('morgan');
const { WebSocketServer } = require('ws');
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));
const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');

const app = express();
const port = process.env.PORT || 3001;
app.use(cors({
  origin: [
    'https://staff-banking.meyer.today',
    'https://client-banking.meyer.today',
    'https://api-banking.meyer.today',
    'http://localhost:3001',
    'http://localhost:8080',
  ],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
}));
app.use(express.json());
app.use(morgan('dev'));

const SERVER_VERSION = '2.0.0';

// ── Firebase ──────────────────────────────────────────────────────────────────
let firebaseInitialized = false;
try {
  const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
  if (b64) {
    const sa = JSON.parse(Buffer.from(b64.trim().replace(/\s/g, ''), 'base64').toString('utf-8'));
    admin.initializeApp({ credential: admin.credential.cert(sa) });
    firebaseInitialized = true;
    console.log('Firebase initialized');
  } else {
    console.warn('Firebase not configured');
  }
} catch (e) {
  console.error('Firebase init error:', e.message);
}

async function sendPush(fcmToken, { title, body, data }) {
  if (!firebaseInitialized) return { success: false };
  try {
    const msg = {
      token: fcmToken,
      notification: { title, body },
      data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])),
      android: {
        priority: 'high',
        notification: {
          channelId: 'auth_channel',
          priority: 'max',
          defaultSound: true,
          defaultVibrateTimings: true,
        },
      },
    };
    const res = await admin.messaging().send(msg);
    console.log('FCM sent:', res);
    return { success: true, messageId: res };
  } catch (e) {
    console.error('FCM error:', e.message);
    return { success: false, error: e.message };
  }
}

// ── Flowable ──────────────────────────────────────────────────────────────────
const FLOWABLE_URL = process.env.FLOWABLE_URL || 'http://localhost:8090/flowable-rest/service';
const FLOWABLE_AUTH = 'Basic ' + Buffer.from('admin:flowable_admin').toString('base64');

async function flowable(method, path, body) {
  const res = await fetch(`${FLOWABLE_URL}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'Authorization': FLOWABLE_AUTH },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Flowable ${method} ${path} → ${res.status}: ${text}`);
  }
  const text = await res.text(); return text ? JSON.parse(text) : null;
}

// ── Auth helpers ──────────────────────────────────────────────────────────────
const now = () => new Date().toISOString();
const response = (data, meta = {}) => ({ data, meta: { timestamp: now(), correlationId: meta.correlationId || 'mock-id' } });

function authenticate(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth) return res.status(401).json({ error: 'Missing token' });
  try {
    req.user = JSON.parse(Buffer.from(auth.replace('Bearer ', ''), 'base64').toString());
    next();
  } catch { return res.status(401).json({ error: 'Invalid token' }); }
}

// ── Users ─────────────────────────────────────────────────────────────────────
const users = [
  { id: 'u001', username: 'client',     password: 'client123',  name: 'Philippe Meyer',      role: 'PRIVATE_CLIENT',       portfolios: ['P-1001','P-1002','P-1003'] },
  { id: 'u002', username: 'rm',         password: 'rm123',      name: 'John Smith',           role: 'RELATIONSHIP_MANAGER', clients: ['u001'] },
  { id: 'u003', username: 'credit',     password: 'credit123',  name: 'Sarah Wilson',         role: 'CREDIT_OFFICER',       signingLimit: 5000000 },
  { id: 'u004', username: 'admin',      password: 'admin123',   name: 'System Administrator', role: 'ADMIN' },
  { id: 'u005', username: 'compliance', password: 'comp123',    name: 'Marie Dubois',         role: 'COMPLIANCE_OFFICER' },
];

const documents = [
  { id: 'DOC-1001', type: 'PORTFOLIO_STATEMENT', title: 'Portfolio Statement - April 2025', date: '2025-04-30', status: 'AVAILABLE',         portfolioId: 'P-1001' },
  { id: 'DOC-1002', type: 'LOMBARD_AGREEMENT',   title: 'Lombard Facility Agreement',       date: '2025-05-15', status: 'PENDING_SIGNATURE', portfolioId: 'P-1001' },
  { id: 'DOC-1003', type: 'TAX_REPORT',          title: 'Tax Report 2024',                  date: '2025-03-31', status: 'AVAILABLE',         portfolioId: 'P-1001' },
];

const notifications = [
  { id: 'N-1', type: 'DOCUMENT_AVAILABLE', title: 'New document available', message: 'Portfolio Statement - April 2025 is available.', read: false, createdAt: now() },
  { id: 'N-2', type: 'PAYMENT_EXECUTED',   title: 'Payment executed',       message: 'Your payment of CHF 25,000 has been executed.',  read: false, createdAt: now() },
];

// ── Instruments ───────────────────────────────────────────────────────────────
const instruments = {
  'AAPL':   { name: 'Apple Inc.',                     isin: 'US0378331005', currency: 'USD', price: 195.42,  vol: 0.012 },
  'NESN':   { name: 'Nestlé SA',                      isin: 'CH0038863350', currency: 'CHF', price: 92.18,   vol: 0.008 },
  'NOVN':   { name: 'Novartis AG',                    isin: 'CH0012221716', currency: 'CHF', price: 88.34,   vol: 0.009 },
  'MSFT':   { name: 'Microsoft Corp.',                isin: 'US5949181045', currency: 'USD', price: 415.20,  vol: 0.011 },
  'GOOGL':  { name: 'Alphabet Inc.',                  isin: 'US02079K3059', currency: 'USD', price: 175.80,  vol: 0.013 },
  'ROG':    { name: 'Roche Holding AG',               isin: 'CH0012032048', currency: 'CHF', price: 245.60,  vol: 0.007 },
  'UBS':    { name: 'UBS Group AG',                   isin: 'CH0244767585', currency: 'CHF', price: 28.45,   vol: 0.014 },
  'BOND-1': { name: 'Swiss Confederation 0.25% 2031', isin: 'CH0000000001', currency: 'CHF', price: 98.23,   vol: 0.002 },
  'BOND-2': { name: 'EU 1.5% 2033',                  isin: 'EU000A3KWAC0', currency: 'EUR', price: 96.45,   vol: 0.003 },
  'BOND-3': { name: 'US Treasury 4.25% 2029',         isin: 'US912828YV68', currency: 'USD', price: 101.20,  vol: 0.002 },
  'CSCO':   { name: 'Cisco Systems Inc.',             isin: 'US17275R1023', currency: 'USD', price: 52.30,   vol: 0.010 },
  'ZURN':   { name: 'Zurich Insurance Group',         isin: 'CH0011075394', currency: 'CHF', price: 512.40,  vol: 0.008 },
};

const fx = { USD: 0.912, EUR: 0.987, CHF: 1.0 };

const indices = {
  'MSCI World':        { value: 3210.45, vol: 0.008 },
  'S&P 500':           { value: 5278.40, vol: 0.009 },
  'Euro Stoxx 50':     { value: 4987.12, vol: 0.010 },
  'Swiss Market Index':{ value: 11792.30,vol: 0.007 },
};

// ── Portfolios ────────────────────────────────────────────────────────────────
const portfolioMeta = {
  'P-1001': { name: 'Global Balanced Portfolio', mandate: 'Balanced',     currency: 'CHF', cash: 2458320.45, color: '#1A56DB' },
  'P-1002': { name: 'Growth Equity Mandate',     mandate: 'Growth',       currency: 'CHF', cash: 842150.20,  color: '#8B5CF6' },
  'P-1003': { name: 'Capital Preservation',      mandate: 'Conservative', currency: 'CHF', cash: 1240000.00, color: '#059669' },
};

const positionBase = [
  { id: 'POS-1',  portfolioId: 'P-1001', instrumentId: 'AAPL',   assetClass: 'Equities',     quantity: 1258  },
  { id: 'POS-2',  portfolioId: 'P-1001', instrumentId: 'NESN',   assetClass: 'Equities',     quantity: 2000  },
  { id: 'POS-3',  portfolioId: 'P-1001', instrumentId: 'BOND-1', assetClass: 'Fixed Income', quantity: 10000 },
  { id: 'POS-4',  portfolioId: 'P-1001', instrumentId: 'MSFT',   assetClass: 'Equities',     quantity: 420   },
  { id: 'POS-5',  portfolioId: 'P-1001', instrumentId: 'NOVN',   assetClass: 'Equities',     quantity: 1800  },
  { id: 'POS-6',  portfolioId: 'P-1001', instrumentId: 'BOND-2', assetClass: 'Fixed Income', quantity: 5000  },
  { id: 'POS-7',  portfolioId: 'P-1001', instrumentId: 'ZURN',   assetClass: 'Equities',     quantity: 150   },
  { id: 'POS-8',  portfolioId: 'P-1002', instrumentId: 'AAPL',   assetClass: 'Equities',     quantity: 850   },
  { id: 'POS-9',  portfolioId: 'P-1002', instrumentId: 'MSFT',   assetClass: 'Equities',     quantity: 620   },
  { id: 'POS-10', portfolioId: 'P-1002', instrumentId: 'GOOGL',  assetClass: 'Equities',     quantity: 480   },
  { id: 'POS-11', portfolioId: 'P-1002', instrumentId: 'CSCO',   assetClass: 'Equities',     quantity: 3200  },
  { id: 'POS-12', portfolioId: 'P-1002', instrumentId: 'NOVN',   assetClass: 'Equities',     quantity: 900   },
  { id: 'POS-13', portfolioId: 'P-1002', instrumentId: 'ROG',    assetClass: 'Equities',     quantity: 420   },
  { id: 'POS-14', portfolioId: 'P-1003', instrumentId: 'BOND-1', assetClass: 'Fixed Income', quantity: 20000 },
  { id: 'POS-15', portfolioId: 'P-1003', instrumentId: 'BOND-2', assetClass: 'Fixed Income', quantity: 15000 },
  { id: 'POS-16', portfolioId: 'P-1003', instrumentId: 'BOND-3', assetClass: 'Fixed Income', quantity: 8000  },
  { id: 'POS-17', portfolioId: 'P-1003', instrumentId: 'NESN',   assetClass: 'Equities',     quantity: 500   },
  { id: 'POS-18', portfolioId: 'P-1003', instrumentId: 'ZURN',   assetClass: 'Equities',     quantity: 80    },
];

const costBasis = {
  'AAPL': 178.00, 'NESN': 88.00, 'BOND-1': 100.00, 'MSFT': 380.00, 'NOVN': 84.00,
  'GOOGL': 155.00, 'ROG': 230.00, 'UBS': 25.00, 'BOND-2': 98.00, 'BOND-3': 99.50,
  'CSCO': 48.00, 'ZURN': 480.00,
};

const transactions = [
  { id: 'TX-1', portfolioId: 'P-1001', tradeDate: '2025-05-23', settlementDate: '2025-05-27', type: 'BUY',      instrument: 'Apple Inc.',    instrumentId: 'AAPL',   quantity: 150,   price: 195.42, currency: 'USD', amountChf: -26423.70,  account: 'Personal 12345678',     status: 'SETTLED' },
  { id: 'TX-2', portfolioId: 'P-1001', tradeDate: '2025-05-22', settlementDate: '2025-05-26', type: 'SELL',     instrument: 'Nestlé SA',     instrumentId: 'NESN',   quantity: 200,   price: 92.18,  currency: 'CHF', amountChf: 18436.00,   account: 'Personal 12345678',     status: 'SETTLED' },
  { id: 'TX-3', portfolioId: 'P-1001', tradeDate: '2025-05-20', settlementDate: '2025-05-20', type: 'DIVIDEND', instrument: 'Novartis AG',   instrumentId: 'NOVN',   quantity: null,  price: null,   currency: 'CHF', amountChf: 246.80,     account: 'Personal 12345678',     status: 'BOOKED'  },
  { id: 'TX-4', portfolioId: 'P-1002', tradeDate: '2025-05-21', settlementDate: '2025-05-25', type: 'BUY',      instrument: 'Alphabet Inc.', instrumentId: 'GOOGL',  quantity: 80,    price: 175.80, currency: 'USD', amountChf: -12825.98,  account: 'Growth 98765432',       status: 'SETTLED' },
  { id: 'TX-5', portfolioId: 'P-1003', tradeDate: '2025-05-19', settlementDate: '2025-05-23', type: 'BUY',      instrument: 'Swiss Conf.',   instrumentId: 'BOND-1', quantity: 2000,  price: 98.23,  currency: 'CHF', amountChf: -196460.00, account: 'Preservation 11223344', status: 'SETTLED' },
];

// ── GBM price simulation ──────────────────────────────────────────────────────
function gbmTick(price, vol) {
  const dt = 3 / (252 * 8 * 3600);
  const z = Math.sqrt(-2 * Math.log(Math.random())) * Math.cos(2 * Math.PI * Math.random());
  return price * Math.exp(-0.5 * vol * vol * dt + vol * Math.sqrt(dt) * z);
}

let priceHistory = {};
let tradeCounter = 100;

// ── Derived data ──────────────────────────────────────────────────────────────
function getLivePositions(portfolioId) {
  return positionBase
    .filter(p => p.portfolioId === portfolioId)
    .map(p => {
      const inst = instruments[p.instrumentId];
      const fxRate = fx[inst.currency] || 1;
      const marketValueChf = p.quantity * inst.price * fxRate;
      const costChf = p.quantity * (costBasis[p.instrumentId] || inst.price) * fxRate;
      return {
        id: p.id, portfolioId: p.portfolioId, instrumentId: p.instrumentId,
        name: inst.name, isin: inst.isin, assetClass: p.assetClass,
        currency: inst.currency, quantity: p.quantity,
        price: +inst.price.toFixed(4),
        marketValueChf: +marketValueChf.toFixed(2),
        unrealizedPlChf: +(marketValueChf - costChf).toFixed(2),
      };
    });
}

function getLivePortfolio(portfolioId) {
  const meta = portfolioMeta[portfolioId];
  if (!meta) return null;
  const positions = getLivePositions(portfolioId);
  const investedValue = positions.reduce((s, p) => s + p.marketValueChf, 0);
  const totalValue = investedValue + meta.cash;
  const prevValue = totalValue * 0.9801;
  const byClass = {};
  for (const p of positions) byClass[p.assetClass] = (byClass[p.assetClass] || 0) + p.marketValueChf;
  byClass['Cash & Money Market'] = (byClass['Cash & Money Market'] || 0) + meta.cash;
  const allocation = Object.entries(byClass).map(([assetClass, valueChf]) => ({
    assetClass, pct: +((valueChf / totalValue) * 100).toFixed(1), valueChf: +valueChf.toFixed(0),
  }));
  return {
    id: portfolioId, name: meta.name, mandate: meta.mandate,
    baseCurrency: meta.currency, color: meta.color,
    value: +totalValue.toFixed(2),
    dayChange: +(totalValue - prevValue).toFixed(2),
    dayChangePct: +((totalValue - prevValue) / prevValue * 100).toFixed(2),
    allocation,
  };
}

function getAllPortfolios() {
  return Object.keys(portfolioMeta).map(id => getLivePortfolio(id));
}

function getAggregatedDashboard() {
  const portfolios = getAllPortfolios();
  const totalAum = portfolios.reduce((s, p) => s + p.value, 0);
  const totalDayChange = portfolios.reduce((s, p) => s + p.dayChange, 0);
  const portfolioAllocation = portfolios.map(p => ({
    portfolioId: p.id, name: p.name, mandate: p.mandate, color: p.color,
    value: p.value, pct: +((p.value / totalAum) * 100).toFixed(1),
  }));
  const allPositions = Object.keys(portfolioMeta).flatMap(id => getLivePositions(id));
  const byClass = {};
  for (const p of allPositions) byClass[p.assetClass] = (byClass[p.assetClass] || 0) + p.marketValueChf;
  const totalCash = Object.values(portfolioMeta).reduce((s, m) => s + m.cash, 0);
  byClass['Cash & Money Market'] = (byClass['Cash & Money Market'] || 0) + totalCash;
  const assetAllocation = Object.entries(byClass).map(([assetClass, valueChf]) => ({
    assetClass, pct: +((valueChf / totalAum) * 100).toFixed(1), valueChf: +valueChf.toFixed(0),
  }));
  return {
    totalAum: +totalAum.toFixed(2),
    totalDayChange: +totalDayChange.toFixed(2),
    totalDayChangePct: +((totalDayChange / (totalAum - totalDayChange)) * 100).toFixed(2),
    portfolios, portfolioAllocation, assetAllocation,
    marketOverview: getMarketOverview(),
    recentActivity: transactions.slice(0, 5),
    unreadNotifications: notifications.filter(n => !n.read).length,
  };
}

function getMarketOverview() {
  return Object.entries(indices).map(([name, idx]) => ({
    name, value: +idx.value.toFixed(2),
    changePct: +(((idx.value / (idx.value / 1.005)) - 1) * 100).toFixed(2),
  }));
}

// ── FCM token persistence ─────────────────────────────────────────────────────
const TOKENS_FILE = '/tmp/fcm_tokens.json';
let fcmTokens = {};
try {
  if (fs.existsSync(TOKENS_FILE)) fcmTokens = JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf-8'));
  console.log(`Loaded ${Object.keys(fcmTokens).length} FCM token(s)`);
} catch (e) { console.warn('Could not load FCM tokens'); }

function saveTokens() {
  try { fs.writeFileSync(TOKENS_FILE, JSON.stringify(fcmTokens)); } catch (e) {}
}

// ── In-memory stores ──────────────────────────────────────────────────────────
const authChallenges = {};
const beneficiaries = {};

// ── Simulation loop ───────────────────────────────────────────────────────────
const connectedClients = new Set();

function broadcast(payload) {
  const msg = JSON.stringify(payload);
  for (const ws of connectedClients) if (ws.readyState === 1) ws.send(msg);
}

function maybeGenerateTrade() {
  if (Math.random() > 0.12) return null;
  const portfolioIds = Object.keys(portfolioMeta);
  const portfolioId = portfolioIds[Math.floor(Math.random() * portfolioIds.length)];
  const instIds = Object.keys(instruments).filter(i => !i.startsWith('BOND'));
  const instrumentId = instIds[Math.floor(Math.random() * instIds.length)];
  const inst = instruments[instrumentId];
  const type = Math.random() > 0.5 ? 'BUY' : 'SELL';
  const quantity = Math.floor(Math.random() * 50) + 10;
  const amountChf = (type === 'BUY' ? -1 : 1) * quantity * inst.price * (fx[inst.currency] || 1);
  const tx = {
    id: `TX-${++tradeCounter}`, portfolioId,
    tradeDate: new Date().toISOString().split('T')[0],
    settlementDate: new Date(Date.now() + 2 * 86400000).toISOString().split('T')[0],
    type, instrument: inst.name, instrumentId, quantity,
    price: +inst.price.toFixed(4), currency: inst.currency,
    amountChf: +amountChf.toFixed(2),
    account: portfolioMeta[portfolioId].name, status: 'PENDING',
  };
  transactions.unshift(tx);
  if (transactions.length > 50) transactions.pop();
  return tx;
}

setInterval(() => {
  // Tick prices
  const priceChanges = [];
  for (const [id, inst] of Object.entries(instruments)) {
    const prev = inst.price;
    inst.price = gbmTick(inst.price, inst.vol);
    priceChanges.push({ instrumentId: id, prev: +prev.toFixed(4), price: +inst.price.toFixed(4), currency: inst.currency });
    if (!priceHistory[id]) priceHistory[id] = [];
    priceHistory[id].push(+inst.price.toFixed(4));
    if (priceHistory[id].length > 60) priceHistory[id].shift();
  }
  for (const idx of Object.values(indices)) idx.value = gbmTick(idx.value, idx.vol);

  const portfolios = getAllPortfolios();
  const totalAum = portfolios.reduce((s, p) => s + p.value, 0);

  broadcast({
    eventId: 'EVT-' + Date.now(), source: 'MARKET_DATA',
    eventType: 'PRICE_UPDATED', occurredAt: now(),
    payload: { prices: priceChanges, portfolios, totalAum: +totalAum.toFixed(2), marketOverview: getMarketOverview() },
  });

  const trade = maybeGenerateTrade();
  if (trade) {
    broadcast({ eventId: 'EVT-' + Date.now(), source: 'AVALOQ_MOCK', eventType: 'TRADE_EXECUTED', occurredAt: now(), payload: { trade } });
  }
}, 3000);

// ── Auth endpoints ────────────────────────────────────────────────────────────
app.post('/api/v1/auth/login', (req, res) => {
  const { username, password } = req.body;
  const user = users.find(u => u.username === username && u.password === password);
  if (!user) return res.status(401).json({ error: { code: 'AUTH_FAILED', message: 'Invalid credentials' } });
  const token = Buffer.from(JSON.stringify({ userId: user.id, role: user.role })).toString('base64');
  res.json({ accessToken: token, tokenType: 'Bearer', expiresIn: 3600, user: { id: user.id, name: user.name, role: user.role } });
});

app.get('/api/v1/auth/session', authenticate, (req, res) => {
  res.json(users.find(u => u.id === req.user.userId));
});

app.post('/auth/fcm-token', authenticate, (req, res) => {
  const { fcmToken } = req.body;
  if (!fcmToken) return res.status(400).json({ error: 'Missing fcmToken' });
  fcmTokens[req.user.userId] = fcmToken;
  saveTokens();
  console.log(`FCM token registered for user ${req.user.userId}`);
  res.json({ success: true });
});

app.post('/auth/web-challenge', async (req, res) => {
  const { username, password } = req.body;
  const user = users.find(u => u.username === username && u.password === password);
  if (!user) return res.status(401).json({ error: { code: 'AUTH_FAILED', message: 'Invalid credentials' } });
  const fcmToken = fcmTokens[user.id];
  if (!fcmToken) return res.status(400).json({ error: { code: 'NO_MOBILE_DEVICE', message: 'No mobile device registered. Please log in via the mobile app first.' } });
  const challengeId = 'CHG-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);
  const expiresAt = Date.now() + 3 * 60 * 1000;
  authChallenges[challengeId] = {
    userId: user.id, status: 'PENDING', expiresAt,
    ipAddress: req.headers['x-forwarded-for'] || req.ip || 'Unknown',
    createdAt: now(),
  };
  await sendPush(fcmToken, {
    title: '🔐 New login request',
    body: 'Someone is trying to log into your account. Tap to approve or reject.',
    data: { type: 'WEB_LOGIN_CHALLENGE', challengeId, userName: user.name, ipAddress: authChallenges[challengeId].ipAddress, timestamp: authChallenges[challengeId].createdAt },
  });
  res.json({ challengeId, expiresAt });
});

app.get('/auth/web-challenge/:id/status', (req, res) => {
  const c = authChallenges[req.params.id];
  if (!c) return res.status(404).json({ error: 'Not found' });
  if (Date.now() > c.expiresAt) c.status = 'EXPIRED';
  if (c.status === 'APPROVED') {
    const user = users.find(u => u.id === c.userId);
    const token = Buffer.from(JSON.stringify({ userId: user.id, role: user.role })).toString('base64');
    delete authChallenges[req.params.id];
    return res.json({ status: 'APPROVED', accessToken: token, user: { id: user.id, name: user.name, role: user.role } });
  }
  res.json({ status: c.status, expiresAt: c.expiresAt });
});

app.post('/auth/web-challenge/:id/approve', authenticate, (req, res) => {
  const c = authChallenges[req.params.id];
  if (!c) return res.status(404).json({ error: 'Not found' });
  if (Date.now() > c.expiresAt) return res.status(400).json({ error: 'Expired' });
  if (c.userId !== req.user.userId) return res.status(403).json({ error: 'Forbidden' });
  c.status = 'APPROVED';
  res.json({ success: true });
});

app.post('/auth/web-challenge/:id/reject', authenticate, (req, res) => {
  const c = authChallenges[req.params.id];
  if (!c) return res.status(404).json({ error: 'Not found' });
  if (c.userId !== req.user.userId) return res.status(403).json({ error: 'Forbidden' });
  c.status = 'REJECTED';
  delete authChallenges[req.params.id];
  res.json({ success: true });
});

// ── Dashboard & portfolio endpoints ───────────────────────────────────────────
app.get('/health', (req, res) => res.json({
  status: 'ok', version: SERVER_VERSION, service: 'private-banking-pi',
  firebase: firebaseInitialized, uptime: Math.floor(process.uptime()), timestamp: now(),
  git: { commit: process.env.GIT_COMMIT?.slice(0, 7) || 'local', branch: process.env.GIT_BRANCH || 'local' },
}));

app.get('/bff/mobile/dashboard', (req, res) => res.json(response(getAggregatedDashboard())));
app.get('/portfolios', (req, res) => res.json(response(getAllPortfolios())));
app.get('/portfolios/:id', (req, res) => res.json(response(getLivePortfolio(req.params.id))));
app.get('/portfolios/:id/positions', (req, res) => {
  const positions = getLivePositions(req.params.id);
  const portfolio = getLivePortfolio(req.params.id);
  if (!portfolio) return res.status(404).json({ error: 'Portfolio not found' });
  res.json(response(positions.map(p => ({ ...p, weightPct: +((p.marketValueChf / portfolio.value) * 100).toFixed(2) }))));
});
app.get('/portfolios/:id/performance', (req, res) => res.json(response({
  portfolioId: req.params.id,
  twr: { mtd: 1.25, ytd: 7.62, oneYear: 12.35, threeYearAnnualized: 8.91 },
  mwr: { ytd: 7.10, sinceInception: 7.85 },
  benchmark: { name: 'MSCI World', ytd: 5.18 },
  excessReturnYtd: 2.44,
})));
app.get('/portfolios/:id/allocation', (req, res) => {
  const p = getLivePortfolio(req.params.id);
  res.json(response(p?.allocation || []));
});
app.get('/portfolios/:id/profitability', (req, res) => {
  const positions = getLivePositions(req.params.id);
  const unrealized = positions.reduce((s, p) => s + p.unrealizedPlChf, 0);
  res.json(response({ portfolioId: req.params.id, realizedPlChf: 245678.90, unrealizedPlChf: +unrealized.toFixed(2), incomeChf: 78342.15, feesChf: -23456.78, totalNetProfitabilityChf: +(unrealized + 245678.90 + 78342.15 - 23456.78).toFixed(2) }));
});
app.get('/portfolios/:id/cash', (req, res) => res.json(response({
  portfolioId: req.params.id,
  totalCashChf: 2458320.45, availableToInvestChf: 1985410.22, pendingChf: 312450.13, restrictedChf: 160460.10,
  currencies: [
    { currency: 'CHF', total: 1250450.10, valueChf: 1250450.10, pct: 50.9 },
    { currency: 'USD', total: 895210.35,  valueChf: 816422.71,  pct: 33.2 },
    { currency: 'EUR', total: 210430.80,  valueChf: 207640.77,  pct: 8.4  },
  ],
})));

// ── Positions, transactions, documents, notifications ─────────────────────────
app.get('/positions/:id', (req, res) => {
  const all = Object.keys(portfolioMeta).flatMap(id => getLivePositions(id));
  res.json(response(all.find(p => p.id === req.params.id) || null));
});
app.get('/transactions', (req, res) => {
  const { portfolioId } = req.query;
  res.json(response(portfolioId ? transactions.filter(t => t.portfolioId === portfolioId) : transactions));
});
app.get('/documents', (req, res) => res.json(response(documents)));
app.get('/documents/:id', (req, res) => res.json(response(documents.find(d => d.id === req.params.id) || null)));
app.post('/documents/:id/acknowledge', (req, res) => res.json(response({ documentId: req.params.id, acknowledged: true, acknowledgedAt: now() })));
app.get('/notifications', (req, res) => res.json(response(notifications)));
app.post('/notifications/:id/read', (req, res) => res.json(response({ notificationId: req.params.id, read: true })));
app.get('/marketdata/quotes/:instrumentId', (req, res) => {
  const inst = instruments[req.params.instrumentId];
  if (!inst) return res.status(404).json({ error: 'Not found' });
  res.json(response({ instrumentId: req.params.instrumentId, price: +inst.price.toFixed(4), currency: inst.currency, history: priceHistory[req.params.instrumentId] || [], timestamp: now() }));
});
app.get('/marketdata/indices', (req, res) => res.json(response(getMarketOverview())));
app.get('/research', (req, res) => res.json(response([
  { id: 'R-1', title: 'Weekly Market Outlook',  provider: 'Research Desk', date: '2025-05-23' },
  { id: 'R-2', title: 'Swiss Equities Update',  provider: 'Research Desk', date: '2025-05-22' },
])));

// ── Payments ──────────────────────────────────────────────────────────────────
app.post('/payments/preview', (req, res) => res.json(response({ feesChf: 5.00, requiresApproval: true, status: 'PREVIEW_OK' })));
app.post('/payments', (req, res) => res.status(201).json(response({ paymentId: 'PAY-' + Date.now(), status: 'PENDING_APPROVAL', ...req.body })));
app.get('/payments/:id/status', (req, res) => res.json(response({ paymentId: req.params.id, status: 'PENDING_SECOND_APPROVAL' })));

// ── Credit ────────────────────────────────────────────────────────────────────
app.get('/credit/lombard/capacity', (req, res) => {
  const totalAum = getAllPortfolios().reduce((s, p) => s + p.value, 0);
  const facility = totalAum * 0.71 * 0.80;
  res.json(response({ portfolioValueChf: +totalAum.toFixed(2), approvedFacilityChf: +facility.toFixed(2), outstandingLoanChf: 2500000, availableCreditChf: +(facility - 2500000).toFixed(2), utilizationPct: +((2500000 / facility) * 100).toFixed(1) }));
});
app.post('/credit/lombard/simulations', (req, res) => res.json(response({ simulationId: 'SIM-' + Date.now(), requestedAmountChf: req.body.amountChf || 500000, estimatedAnnualInterestChf: 6250, postDrawdownUtilizationPct: 52.8, eligible: true })));

// ── Beneficiary endpoints ─────────────────────────────────────────────────────
app.get('/beneficiaries', authenticate, (req, res) => {
  res.json({ data: beneficiaries[req.user.userId] || [] });
});

app.post('/beneficiaries', authenticate, async (req, res) => {
  const { beneficiaryName, iban, bankName, bankCountry, currency } = req.body;
  if (!beneficiaryName || !iban) return res.status(400).json({ error: 'Missing required fields' });
  const user = users.find(u => u.id === req.user.userId);
  const beneficiaryId = 'BEN-' + Date.now();
  if (!beneficiaries[req.user.userId]) beneficiaries[req.user.userId] = [];
  const beneficiary = {
    id: beneficiaryId, beneficiaryName, iban,
    bankName: bankName || '', bankCountry: bankCountry || '', currency: currency || 'CHF',
    status: 'PENDING_APPROVAL', requestedAt: now(),
    customerId: req.user.userId, customerName: user.name,
  };
  beneficiaries[req.user.userId].push(beneficiary);
  try {
    const process = await flowable('POST', '/runtime/process-instances', {
      processDefinitionKey: 'beneficiaryRegistration',
      businessKey: beneficiaryId,
      variables: [
        { name: 'beneficiaryId',   value: beneficiaryId,         type: 'string' },
        { name: 'beneficiaryName', value: beneficiaryName,        type: 'string' },
        { name: 'iban',            value: iban,                   type: 'string' },
        { name: 'bankName',        value: bankName || '',         type: 'string' },
        { name: 'bankCountry',     value: bankCountry || '',      type: 'string' },
        { name: 'currency',        value: currency || 'CHF',      type: 'string' },
        { name: 'customerId',      value: req.user.userId,        type: 'string' },
        { name: 'customerName',    value: user.name,              type: 'string' },
        { name: 'requestedAt',     value: now(),                  type: 'string' },
      ],
    });
    beneficiary.processInstanceId = process.id;
    console.log(`Flowable process started: ${process.id}`);
  } catch (e) {
    console.error('Flowable error:', e.message);
  }
  res.status(201).json({ data: beneficiary });
});

app.get('/beneficiaries/:id', authenticate, (req, res) => {
  const list = beneficiaries[req.user.userId] || [];
  const b = list.find(b => b.id === req.params.id);
  if (!b) return res.status(404).json({ error: 'Not found' });
  res.json({ data: b });
});

app.delete('/beneficiaries/:id', authenticate, (req, res) => {
  const list = beneficiaries[req.user.userId] || [];
  const idx = list.findIndex(b => b.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  list.splice(idx, 1);
  res.json({ success: true });
});

// ── Flowable task proxy ───────────────────────────────────────────────────────
app.get('/workflow/tasks', authenticate, async (req, res) => {
  try {
    const data = await flowable('GET', '/runtime/tasks?processDefinitionKey=beneficiaryRegistration&size=50');
    const tasks = await Promise.all((data.data || []).map(async (task) => {
      try {
        // Fetch from process instance — variables are process-scoped not task-scoped
        const vars = await flowable('GET', `/runtime/process-instances/${task.processInstanceId}/variables`);
        const varMap = {};
        (vars || []).forEach(v => varMap[v.name] = v.value);
        return { ...task, variables: varMap };
      } catch (e) {
        console.error('Failed to get vars for task', task.id, e.message);
        return { ...task, variables: {} };
      }
    }));
    res.json({ data: tasks, total: data.total });
  } catch (e) {
    console.error('Flowable tasks error:', e.message);
    res.status(502).json({ error: 'Flowable unavailable', detail: e.message });
  }
});

app.get('/workflow/tasks/:taskId', authenticate, async (req, res) => {
  try {
    const task = await flowable('GET', `/runtime/tasks/${req.params.taskId}`);
    // Fetch variables from process instance scope
    const vars = await flowable('GET', `/runtime/process-instances/${task.processInstanceId}/variables`);
    const varMap = {};
    (vars || []).forEach(v => varMap[v.name] = v.value);
    res.json({ data: { ...task, variables: varMap } });
  } catch (e) {
    console.error('Task detail error:', e.message);
    res.status(502).json({ error: 'Flowable unavailable' });
  }
});

app.post('/workflow/tasks/:taskId/complete', authenticate, async (req, res) => {
  const { decision, staffComment } = req.body;
  if (!decision) return res.status(400).json({ error: 'decision required' });
  try {
    // Complete the Flowable task — now fast since no HTTP service tasks
    await flowable('POST', `/runtime/tasks/${req.params.taskId}`, {
      action: 'complete',
      variables: [
        { name: 'decision',     value: decision,            type: 'string' },
        { name: 'staffComment', value: staffComment || '',  type: 'string' },
        { name: 'reviewedBy',   value: req.user.userId,     type: 'string' },
        { name: 'reviewedAt',   value: now(),               type: 'string' },
      ],
    });

    // Get process variables to know what to notify
    const taskInfo = await flowable('GET', `/history/historic-task-instances/${req.params.taskId}`);
    const processId = taskInfo?.processInstanceId;

    if (processId) {
      const vars = await flowable('GET', `/history/historic-variable-instances?processInstanceId=${processId}`);
      const varMap = {};
      (vars?.data || []).forEach(v => varMap[v.variable.name] = v.variable.value);

      const customerId = varMap.customerId;
      const beneficiaryName = varMap.beneficiaryName;
      const iban = varMap.iban;
      const notificationType = decision === 'APPROVE' ? 'BENEFICIARY_APPROVED' : 'BENEFICIARY_REJECTED_STAFF';

      // Update beneficiary status in memory
      const list = Object.values(beneficiaries).flat();
      const b = list.find(b => b.beneficiaryName === beneficiaryName && b.iban === iban);
      if (b) {
        b.status = decision === 'APPROVE' ? 'ACTIVE' : 'REJECTED';
        b.resolvedAt = now();
        if (staffComment) b.staffComment = staffComment;
        broadcast({ eventType: 'BENEFICIARY_UPDATED', payload: b, occurredAt: now() });
      }

      // Send push notification
      const fcmToken = fcmTokens[customerId];
      if (fcmToken) {
        const messages = {
          BENEFICIARY_APPROVED:       { title: '✅ Beneficiary Approved',              body: `${beneficiaryName} is now active.` },
          BENEFICIARY_REJECTED_STAFF: { title: '❌ Beneficiary Registration Declined', body: `${beneficiaryName} was declined.${staffComment ? ' Reason: ' + staffComment : ''}` },
        };
        const msg = messages[notificationType];
        if (msg) await sendPush(fcmToken, { ...msg, data: { type: notificationType, beneficiaryName, iban, customerId } });
      }
      console.log(`Task ${req.params.taskId} completed: ${decision} for ${beneficiaryName}`);
    }
    res.json({ success: true, decision });
  } catch (e) {
    console.error('Complete task error:', e.message);
    res.status(502).json({ error: 'Failed to complete task', detail: e.message });
  }
});

// ── Internal webhook from Flowable ────────────────────────────────────────────
app.post('/internal/notify', (req, res) => {
  // Respond immediately so Flowable doesn't hang
  res.json({ success: true });
  
  // Process asynchronously after response
  const { customerId, type, beneficiaryName, iban, staffComment } = req.body;
  console.log(`Notify: ${type} for ${customerId}`);
  
  // Update beneficiary status
  const list = Object.values(beneficiaries).flat();
  const b = list.find(b => b.beneficiaryName === beneficiaryName && b.iban === iban);
  if (b) {
    b.status = type === 'BENEFICIARY_APPROVED' ? 'ACTIVE' : 'REJECTED';
    b.resolvedAt = now();
    if (staffComment) b.staffComment = staffComment;
    broadcast({ eventType: 'BENEFICIARY_UPDATED', payload: b, occurredAt: now() });
  }

  // Send push notification asynchronously
  const fcmToken = fcmTokens[customerId];
  if (fcmToken) {
    const messages = {
      BENEFICIARY_APPROVED:           { title: '✅ Beneficiary Approved',              body: `${beneficiaryName} (${iban}) is now active.` },
      BENEFICIARY_REJECTED_IBAN:      { title: '❌ Beneficiary Registration Failed',   body: `Invalid IBAN for ${beneficiaryName}.` },
      BENEFICIARY_REJECTED_SANCTIONS: { title: '❌ Beneficiary Registration Failed',   body: `${beneficiaryName} could not be approved.` },
      BENEFICIARY_REJECTED_STAFF:     { title: '❌ Beneficiary Registration Declined', body: `${beneficiaryName} was declined.${staffComment ? ' Reason: ' + staffComment : ''}` },
    };
    const msg = messages[type];
    if (msg) sendPush(fcmToken, { ...msg, data: { type, beneficiaryName, iban, customerId } });
  }
});

app.post('/internal/validate-iban', (req, res) => {
  const clean = (req.body.iban || '').replace(/\s/g, '').toUpperCase();
  const valid = /^[A-Z]{2}[0-9]{2}[A-Z0-9]{4}[0-9]{7}([A-Z0-9]?){0,16}$/.test(clean);
  res.json({ valid, iban: clean });
});

// ── Workflow tasks (legacy) ───────────────────────────────────────────────────
app.get('/workflow/tasks-legacy', (req, res) => res.json(response([])));
app.post('/workflow/tasks/:taskId/approve', (req, res) => res.json(response({ taskId: req.params.taskId, status: 'APPROVED' })));
app.post('/workflow/tasks/:taskId/reject',  (req, res) => res.json(response({ taskId: req.params.taskId, status: 'REJECTED' })));

// ── Signatures ────────────────────────────────────────────────────────────────
app.post('/signatures/requests', (req, res) => res.status(201).json(response({ signatureRequestId: 'SIG-' + Date.now(), status: 'SENT' })));
app.get('/signatures/requests/:id', (req, res) => res.json(response({ signatureRequestId: req.params.id, status: 'SIGNED', signedAt: now() })));

// ── Static files ──────────────────────────────────────────────────────────────
app.use('/static', express.static(path.join(__dirname, '..', 'client-web')));
app.use('/login', express.static(path.join(__dirname, 'public')));

// ── Cleanup ───────────────────────────────────────────────────────────────────
setInterval(() => {
  const n = Date.now();
  for (const [id, c] of Object.entries(authChallenges)) {
    if (n > c.expiresAt + 60000) delete authChallenges[id];
  }
}, 60000);

// ── WebSocket ─────────────────────────────────────────────────────────────────
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/events' });

wss.on('connection', (ws) => {
  connectedClients.add(ws);
  ws.send(JSON.stringify({ eventType: 'CONNECTED', timestamp: now(), payload: { dashboard: getAggregatedDashboard() } }));
  ws.on('close', () => connectedClients.delete(ws));
  ws.on('error', () => connectedClients.delete(ws));
});

server.listen(port, () => {
  console.log(`\n🏦 Private Banking Pi Server v${SERVER_VERSION}`);
  console.log(`   REST → http://localhost:${port}`);
  console.log(`   WS   → ws://localhost:${port}/events`);
  console.log(`   Firebase: ${firebaseInitialized ? 'READY' : 'NOT CONFIGURED'}`);
  console.log(`   Flowable: ${FLOWABLE_URL}\n`);
});
