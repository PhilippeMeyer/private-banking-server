const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const swaggerUi = require('swagger-ui-express');
const http = require('http');
const { WebSocketServer } = require('ws');
const admin = require('firebase-admin');

const app = express();
const port = process.env.PORT || 3000;
app.use(cors());
app.use(express.json());
app.use(morgan('dev'));

// ── Firebase Admin SDK init (for push notifications) ─────────────────────────
let firebaseInitialized = false;
try {
  const serviceAccountB64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
  if (serviceAccountB64) {
    const serviceAccount = JSON.parse(Buffer.from(serviceAccountB64, 'base64').toString('utf-8'));
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    firebaseInitialized = true;
    console.log('Firebase Admin SDK initialized');
  } else {
    console.warn('FIREBASE_SERVICE_ACCOUNT_BASE64 not set — push notifications disabled');
  }
} catch (err) {
  console.error('Firebase Admin SDK init error:', err.message);
}

async function sendPushNotification(fcmToken, { title, body, data }) {
  if (!firebaseInitialized) {
    console.warn('Firebase not initialized — skipping push notification');
    return { success: false, error: 'Firebase not configured' };
  }
  try {
    const message = {
      token: fcmToken,
      notification: { title, body },
      data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])),
      android: { priority: 'high' },
      apns: { headers: { 'apns-priority': '10' } },
    };
    const response = await admin.messaging().send(message);
    console.log('FCM sent:', response);
    return { success: true, messageId: response };
  } catch (err) {
    console.error('FCM send error:', err.message);
    return { success: false, error: err.message };
  }
}

// ── Auth helpers ──────────────────────────────────────────────────────────────
function authenticate(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth) return res.status(401).json({ error: 'Missing token' });
  try {
    req.user = JSON.parse(Buffer.from(auth.replace('Bearer ', ''), 'base64').toString());
    next();
  } catch { return res.status(401).json({ error: 'Invalid token' }); }
}

const now = () => new Date().toISOString();
const response = (data, meta = {}) => ({ data, meta: { timestamp: now(), correlationId: meta.correlationId || 'mock-id' } });

// ── Users ──────────────────────────────────────────────────────────────────────
const users = [
  { id: 'u001', username: 'client',  password: 'client123',  name: 'Philippe Meyer',      role: 'PRIVATE_CLIENT',       portfolios: ['P-1001','P-1002','P-1003'] },
  { id: 'u002', username: 'rm',      password: 'rm123',      name: 'John Smith',           role: 'RELATIONSHIP_MANAGER', clients: ['u001'] },
  { id: 'u003', username: 'credit',  password: 'credit123',  name: 'Sarah Wilson',         role: 'CREDIT_OFFICER',       signingLimit: 5000000 },
  { id: 'u004', username: 'admin',   password: 'admin123',   name: 'System Administrator', role: 'ADMIN' }
];

const documents = [
  { id: 'DOC-1001', type: 'PORTFOLIO_STATEMENT', title: 'Portfolio Statement - April 2025', date: '2025-04-30', status: 'AVAILABLE',         portfolioId: 'P-1001' },
  { id: 'DOC-1002', type: 'LOMBARD_AGREEMENT',   title: 'Lombard Facility Agreement',       date: '2025-05-15', status: 'PENDING_SIGNATURE', portfolioId: 'P-1001' },
  { id: 'DOC-1003', type: 'TAX_REPORT',          title: 'Tax Report 2024',                  date: '2025-03-31', status: 'AVAILABLE',         portfolioId: 'P-1001' }
];

const notifications = [
  { id: 'N-1', type: 'DOCUMENT_AVAILABLE', title: 'New document available', message: 'Portfolio Statement - April 2025 is available.', read: false, createdAt: now() },
  { id: 'N-2', type: 'PAYMENT_EXECUTED',   title: 'Payment executed',       message: 'Your payment of CHF 25,000 has been executed.',  read: false, createdAt: now() }
];

// ── Instruments ───────────────────────────────────────────────────────────────
const instruments = {
  'AAPL':   { name: 'Apple Inc.',                     isin: 'US0378331005', currency: 'USD', price: 195.42,  vol: 0.012 },
  'NESN':   { name: 'Nestlé SA',                      isin: 'CH0038863350', currency: 'CHF', price: 92.18,   vol: 0.008 },
  'NOVN':   { name: 'Novartis AG',                    isin: 'CH0012221716', currency: 'CHF', price: 88.34,   vol: 0.009 },
  'MSFT':   { name: 'Microsoft Corp.',                isin: 'US5949181045', currency: 'USD', price: 415.20,  vol: 0.011 },
  'GOOGL':  { name: 'Alphabet Inc.',                  isin: 'US02079K3059', currency: 'USD', price: 175.80,  vol: 0.013 },
  'ROG':    { name: 'Roche Holding AG',               isin: 'CH0012221716', currency: 'CHF', price: 245.60,  vol: 0.007 },
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

// ── Portfolios ─────────────────────────────────────────────────────────────────
const portfolioMeta = {
  'P-1001': { name: 'Global Balanced Portfolio', mandate: 'Balanced',       currency: 'CHF', cash: 2458320.45, color: '#1A56DB' },
  'P-1002': { name: 'Growth Equity Mandate',     mandate: 'Growth',         currency: 'CHF', cash: 842150.20,  color: '#8B5CF6' },
  'P-1003': { name: 'Capital Preservation',      mandate: 'Conservative',   currency: 'CHF', cash: 1240000.00, color: '#059669' },
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
  { id: 'TX-1', portfolioId: 'P-1001', tradeDate: '2025-05-23', settlementDate: '2025-05-27', type: 'BUY',      instrument: 'Apple Inc.',   instrumentId: 'AAPL',   quantity: 150, price: 195.42, currency: 'USD', amountChf: -26423.70, account: 'Personal 12345678', status: 'SETTLED' },
  { id: 'TX-2', portfolioId: 'P-1001', tradeDate: '2025-05-22', settlementDate: '2025-05-26', type: 'SELL',     instrument: 'Nestlé SA',    instrumentId: 'NESN',   quantity: 200, price: 92.18,  currency: 'CHF', amountChf: 18436.00,  account: 'Personal 12345678', status: 'SETTLED' },
  { id: 'TX-3', portfolioId: 'P-1001', tradeDate: '2025-05-20', settlementDate: '2025-05-20', type: 'DIVIDEND', instrument: 'Novartis AG',  instrumentId: 'NOVN',   quantity: null,price: null,   currency: 'CHF', amountChf: 246.80,    account: 'Personal 12345678', status: 'BOOKED'  },
  { id: 'TX-4', portfolioId: 'P-1002', tradeDate: '2025-05-21', settlementDate: '2025-05-25', type: 'BUY',      instrument: 'Alphabet Inc.',instrumentId: 'GOOGL',  quantity: 80,  price: 175.80, currency: 'USD', amountChf: -12825.98, account: 'Growth 98765432',   status: 'SETTLED' },
  { id: 'TX-5', portfolioId: 'P-1003', tradeDate: '2025-05-19', settlementDate: '2025-05-23', type: 'BUY',      instrument: 'Swiss Conf.',  instrumentId: 'BOND-1', quantity: 2000, price: 98.23, currency: 'CHF', amountChf: -196460.00, account: 'Preservation 11223344', status: 'SETTLED' },
];

// ── GBM price simulation ──────────────────────────────────────────────────────
function gbmTick(price, vol) {
  const dt = 3 / (252 * 8 * 3600);
  const z = Math.sqrt(-2 * Math.log(Math.random())) * Math.cos(2 * Math.PI * Math.random());
  return price * Math.exp(-0.5 * vol * vol * dt + vol * Math.sqrt(dt) * z);
}

let priceHistory = {};
let connectedClients = new Set();

function getLivePositions(portfolioId) {
  return positionBase
    .filter(p => p.portfolioId === portfolioId)
    .map(p => {
      const inst = instruments[p.instrumentId];
      const price = inst.price;
      const fxRate = fx[inst.currency] || 1;
      const marketValueChf = p.quantity * price * fxRate;
      const costChf = p.quantity * (costBasis[p.instrumentId] || price) * fxRate;
      return {
        id: p.id, portfolioId: p.portfolioId, instrumentId: p.instrumentId,
        name: inst.name, isin: inst.isin, assetClass: p.assetClass,
        currency: inst.currency, quantity: p.quantity,
        price: +price.toFixed(4),
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
  const allocation = getAllocation(portfolioId, positions, totalValue);
  return {
    id: portfolioId, name: meta.name, mandate: meta.mandate, baseCurrency: meta.currency, color: meta.color,
    value: +totalValue.toFixed(2),
    dayChange: +(totalValue - prevValue).toFixed(2),
    dayChangePct: +((totalValue - prevValue) / prevValue * 100).toFixed(2),
    allocation,
  };
}

function getAllocation(portfolioId, positions, totalValue) {
  const meta = portfolioMeta[portfolioId];
  const byClass = {};
  for (const p of positions) byClass[p.assetClass] = (byClass[p.assetClass] || 0) + p.marketValueChf;
  byClass['Cash & Money Market'] = (byClass['Cash & Money Market'] || 0) + meta.cash;
  return Object.entries(byClass).map(([assetClass, valueChf]) => ({
    assetClass, pct: +((valueChf / totalValue) * 100).toFixed(1), valueChf: +valueChf.toFixed(0),
  }));
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

// ── Simulation loop ───────────────────────────────────────────────────────────
let tradeCounter = 100;
function tickPrices() {
  const changed = [];
  for (const [id, inst] of Object.entries(instruments)) {
    const prev = inst.price;
    inst.price = gbmTick(inst.price, inst.vol);
    changed.push({ instrumentId: id, prev: +prev.toFixed(4), price: +inst.price.toFixed(4), currency: inst.currency });
    if (!priceHistory[id]) priceHistory[id] = [];
    priceHistory[id].push(+inst.price.toFixed(4));
    if (priceHistory[id].length > 60) priceHistory[id].shift();
  }
  for (const idx of Object.values(indices)) idx.value = gbmTick(idx.value, idx.vol);
  return changed;
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

function broadcast(payload) {
  const msg = JSON.stringify(payload);
  for (const ws of connectedClients) if (ws.readyState === 1) ws.send(msg);
}

setInterval(() => {
  const priceChanges = tickPrices();
  const portfolios = getAllPortfolios();
  const totalAum = portfolios.reduce((s, p) => s + p.value, 0);
  broadcast({
    eventId: 'EVT-' + Date.now(), source: 'MARKET_DATA', eventType: 'PRICE_UPDATED', occurredAt: now(),
    payload: { prices: priceChanges, portfolios, totalAum: +totalAum.toFixed(2), marketOverview: getMarketOverview() }
  });
  const trade = maybeGenerateTrade();
  if (trade) broadcast({ eventId: 'EVT-' + Date.now(), source: 'AVALOQ_MOCK', eventType: 'TRADE_EXECUTED', occurredAt: now(), payload: { trade } });
}, 3000);

// ── Auth endpoints ────────────────────────────────────────────────────────────
app.get('/api/v1/auth/session', authenticate, (req, res) => res.json(users.find(u => u.id === req.user.userId)));
app.post('/api/v1/auth/login', (req, res) => {
  const { username, password } = req.body;
  const user = users.find(u => u.username === username && u.password === password);
  if (!user) return res.status(401).json({ error: { code: 'AUTH_FAILED', message: 'Invalid username or password' } });
  const token = Buffer.from(JSON.stringify({ userId: user.id, role: user.role })).toString('base64');
  res.json({ accessToken: token, tokenType: 'Bearer', expiresIn: 3600, user: { id: user.id, name: user.name, role: user.role } });
});

app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: now(), firebaseReady: firebaseInitialized }));
app.use('/static', express.static('public'));

// ── Web login challenge (push notification approval) ─────────────────────────
const fcmTokens = {};
const authChallenges = {};

app.post('/auth/fcm-token', authenticate, (req, res) => {
  const { fcmToken } = req.body;
  if (!fcmToken) return res.status(400).json({ error: 'Missing fcmToken' });
  fcmTokens[req.user.userId] = fcmToken;
  console.log(`FCM token registered for user ${req.user.userId}`);
  res.json({ success: true });
});

app.post('/auth/web-challenge', async (req, res) => {
  const { username, password } = req.body;
  const user = users.find(u => u.username === username && u.password === password);
  if (!user) return res.status(401).json({ error: { code: 'AUTH_FAILED', message: 'Invalid credentials' } });

  const fcmToken = fcmTokens[user.id];
  if (!fcmToken) {
    return res.status(400).json({ error: { code: 'NO_MOBILE_DEVICE', message: 'No mobile device registered for this account. Please log in via the mobile app first.' } });
  }

  const challengeId = 'CHG-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);
  const expiresAt = Date.now() + 3 * 60 * 1000;
  authChallenges[challengeId] = {
    userId: user.id, userName: user.name, status: 'PENDING', expiresAt,
    ipAddress: req.ip || req.headers['x-forwarded-for'] || 'Unknown',
    userAgent: req.headers['user-agent'] || 'Unknown',
    createdAt: new Date().toISOString(),
  };

  const result = await sendPushNotification(fcmToken, {
    title: '🔐 New login request',
    body: 'Someone is trying to log into your account. Tap to approve or reject.',
    data: {
      type: 'WEB_LOGIN_CHALLENGE', challengeId, userName: user.name,
      ipAddress: authChallenges[challengeId].ipAddress,
      timestamp: authChallenges[challengeId].createdAt,
    },
  });
  if (!result.success) console.warn('Push notification failed:', result.error);

  res.json({ challengeId, expiresAt, message: 'Please approve the login request on your mobile device.' });
});

app.get('/auth/web-challenge/:challengeId/status', (req, res) => {
  const challenge = authChallenges[req.params.challengeId];
  if (!challenge) return res.status(404).json({ error: 'Challenge not found' });
  if (Date.now() > challenge.expiresAt) challenge.status = 'EXPIRED';
  if (challenge.status === 'APPROVED') {
    const user = users.find(u => u.id === challenge.userId);
    const token = Buffer.from(JSON.stringify({ userId: user.id, role: user.role })).toString('base64');
    delete authChallenges[req.params.challengeId];
    return res.json({ status: 'APPROVED', accessToken: token, user: { id: user.id, name: user.name, role: user.role } });
  }
  res.json({ status: challenge.status, expiresAt: challenge.expiresAt });
});

app.post('/auth/web-challenge/:challengeId/approve', authenticate, (req, res) => {
  const challenge = authChallenges[req.params.challengeId];
  if (!challenge) return res.status(404).json({ error: 'Challenge not found or already used' });
  if (Date.now() > challenge.expiresAt) return res.status(400).json({ error: 'Challenge expired' });
  if (challenge.userId !== req.user.userId) return res.status(403).json({ error: 'Forbidden' });
  challenge.status = 'APPROVED';
  res.json({ success: true, message: 'Login approved' });
});

app.post('/auth/web-challenge/:challengeId/reject', authenticate, (req, res) => {
  const challenge = authChallenges[req.params.challengeId];
  if (!challenge) return res.status(404).json({ error: 'Challenge not found' });
  if (challenge.userId !== req.user.userId) return res.status(403).json({ error: 'Forbidden' });
  challenge.status = 'REJECTED';
  delete authChallenges[req.params.challengeId];
  res.json({ success: true, message: 'Login rejected' });
});

setInterval(() => {
  const nowMs = Date.now();
  for (const [id, challenge] of Object.entries(authChallenges)) {
    if (nowMs > challenge.expiresAt + 60000) delete authChallenges[id];
  }
}, 60000);

// ── Dashboard & portfolio endpoints ──────────────────────────────────────────
app.get('/bff/mobile/dashboard', (req, res) => res.json(response(getAggregatedDashboard())));
app.get('/portfolios', (req, res) => res.json(response(getAllPortfolios())));
app.get('/portfolios/:id', (req, res) => res.json(response(getLivePortfolio(req.params.id))));
app.get('/portfolios/:id/positions', (req, res) => {
  const positions = getLivePositions(req.params.id);
  const portfolio = getLivePortfolio(req.params.id);
  res.json(response(positions.map(p => ({ ...p, weightPct: +((p.marketValueChf / portfolio.value) * 100).toFixed(2) }))));
});
app.get('/portfolios/:id/performance', (req, res) => res.json(response({
  portfolioId: req.params.id,
  twr: { mtd: 1.25, ytd: 7.62, oneYear: 12.35, threeYearAnnualized: 8.91 },
  mwr: { ytd: 7.10, sinceInception: 7.85 },
  benchmark: { name: 'MSCI World', ytd: 5.18 },
  excessReturnYtd: 2.44
})));
app.get('/portfolios/:id/allocation', (req, res) => {
  const portfolio = getLivePortfolio(req.params.id);
  res.json(response(portfolio?.allocation || []));
});

// ── Other endpoints ────────────────────────────────────────────────────────────
app.get('/positions/:id', (req, res) => {
  const all = Object.keys(portfolioMeta).flatMap(id => getLivePositions(id));
  res.json(response(all.find(p => p.id === req.params.id) || null));
});
app.get('/transactions', (req, res) => {
  const { portfolioId } = req.query;
  const result = portfolioId ? transactions.filter(t => t.portfolioId === portfolioId) : transactions;
  res.json(response(result));
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
app.post('/payments/preview', (req, res) => res.json(response({ feesChf: 5.00, requiresApproval: true, status: 'PREVIEW_OK' })));
app.post('/payments', (req, res) => res.status(201).json(response({ paymentId: 'PAY-' + Date.now(), status: 'PENDING_APPROVAL', ...req.body })));
app.get('/credit/lombard/capacity', (req, res) => {
  const totalAum = getAllPortfolios().reduce((s, p) => s + p.value, 0);
  const facility = totalAum * 0.71 * 0.80;
  res.json(response({ portfolioValueChf: +totalAum.toFixed(2), approvedFacilityChf: +facility.toFixed(2), outstandingLoanChf: 2500000, availableCreditChf: +(facility - 2500000).toFixed(2), utilizationPct: +((2500000 / facility) * 100).toFixed(1) }));
});
app.get('/research', (req, res) => res.json(response([
  { id: 'R-1', title: 'Weekly Market Outlook', provider: 'Research Desk', date: '2025-05-23' },
  { id: 'R-2', title: 'Swiss Equities Update', provider: 'Research Desk', date: '2025-05-22' },
])));
app.get('/workflow/tasks', (req, res) => res.json(response([])));

const swaggerDocument = { openapi: '3.0.3', info: { title: 'Private Banking Mock API v2', version: '2.2.0' }, servers: [{ url: 'http://localhost:3000' }], paths: {} };
app.use('/docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument));

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
  console.log(`\n🏦 Private Banking Mock Server v2.2 — Multi-Portfolio + Push Auth`);
  console.log(`   REST → http://localhost:${port}`);
  console.log(`   WS   → ws://localhost:${port}/events`);
  console.log(`   Firebase: ${firebaseInitialized ? 'READY' : 'NOT CONFIGURED'}\n`);
});
