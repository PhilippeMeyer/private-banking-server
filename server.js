const express = require('express');
const cors = require('cors');
const http = require('http');
const morgan = require('morgan');
const { WebSocketServer } = require('ws');
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));
const fs = require('fs');
const admin = require('firebase-admin');

const app = express();
const port = process.env.PORT || 3001;
app.use(cors({ origin: true, credentials: true, methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'], allowedHeaders: ['Content-Type', 'Authorization'] }));
app.use(express.json());
app.use(morgan('dev'));

const SERVER_VERSION = '3.4.0';

// ── Firebase ──────────────────────────────────────────────────────────────────
let firebaseInitialized = false;
try {
  const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
  if (b64) {
    const sa = JSON.parse(Buffer.from(b64.trim().replace(/\s/g, ''), 'base64').toString('utf-8'));
    admin.initializeApp({ credential: admin.credential.cert(sa) });
    firebaseInitialized = true;
    console.log('Firebase initialized');
  }
} catch (e) { console.error('Firebase init error:', e.message); }

async function sendPush(fcmToken, { title, body, data }) {
  if (!firebaseInitialized) return;
  try {
    const res = await admin.messaging().send({
      token: fcmToken,
      notification: { title, body },
      data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])),
      android: { priority: 'high', notification: { channelId: 'auth_channel', priority: 'max' } },
    });
    console.log('FCM sent:', res);
  } catch (e) { console.error('FCM error:', e.message); }
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
  if (!res.ok) { const t = await res.text(); throw new Error(`Flowable ${method} ${path} → ${res.status}: ${t}`); }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

const now = () => new Date().toISOString();
const response = (data) => ({ data, meta: { timestamp: now() } });

function authenticate(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth) return res.status(401).json({ error: 'Missing token' });
  try { req.user = JSON.parse(Buffer.from(auth.replace('Bearer ', ''), 'base64').toString()); next(); }
  catch { return res.status(401).json({ error: 'Invalid token' }); }
}

// ── Users & config ────────────────────────────────────────────────────────────
const users = [
  { id: 'u001', username: 'client', password: 'client123', name: 'Philippe Meyer', role: 'PRIVATE_CLIENT', portfolios: ['P-1001', 'P-1002', 'P-1003'] },
  { id: 'u002', username: 'rm', password: 'rm123', name: 'John Smith', role: 'RELATIONSHIP_MANAGER' },
  { id: 'u003', username: 'credit', password: 'credit123', name: 'Sarah Wilson', role: 'CREDIT_OFFICER' },
  { id: 'u004', username: 'admin', password: 'admin123', name: 'System Administrator', role: 'ADMIN' },
  { id: 'u005', username: 'compliance', password: 'comp123', name: 'Marie Dubois', role: 'COMPLIANCE_OFFICER' },
  { id: 'u006', username: 'sophie', password: 'sophie123', name: 'Sophie Meyer', role: 'PRIVATE_CLIENT', portfolios: [], coSignerFor: ['u001'] },
];

const clientConfig = {
  'u001': { coSignerId: 'u006', coSignerName: 'Sophie Meyer', coSignThreshold: 10000, rmThreshold: 50000 },
};

const roleTaskMap = {
  'COMPLIANCE_OFFICER': ['staffReview', 'complianceValidation'],
  'RELATIONSHIP_MANAGER': ['rmApproval', 'customerCallback', 'rmInput'],
  'ADMIN': null,
};

// ── Market data ───────────────────────────────────────────────────────────────
const instruments = {
  'AAPL': { name: 'Apple Inc.', isin: 'US0378331005', currency: 'USD', price: 195.42, vol: 0.012 },
  'NESN': { name: 'Nestlé SA', isin: 'CH0038863350', currency: 'CHF', price: 92.18, vol: 0.008 },
  'NOVN': { name: 'Novartis AG', isin: 'CH0012221716', currency: 'CHF', price: 88.34, vol: 0.009 },
  'MSFT': { name: 'Microsoft Corp.', isin: 'US5949181045', currency: 'USD', price: 415.20, vol: 0.011 },
  'GOOGL': { name: 'Alphabet Inc.', isin: 'US02079K3059', currency: 'USD', price: 175.80, vol: 0.013 },
  'ROG': { name: 'Roche Holding AG', isin: 'CH0012032048', currency: 'CHF', price: 245.60, vol: 0.007 },
  'UBS': { name: 'UBS Group AG', isin: 'CH0244767585', currency: 'CHF', price: 28.45, vol: 0.014 },
  'BOND-1': { name: 'Swiss Confederation 0.25% 2031', isin: 'CH0000000001', currency: 'CHF', price: 98.23, vol: 0.002 },
  'BOND-2': { name: 'EU 1.5% 2033', isin: 'EU000A3KWAC0', currency: 'EUR', price: 96.45, vol: 0.003 },
  'BOND-3': { name: 'US Treasury 4.25% 2029', isin: 'US912828YV68', currency: 'USD', price: 101.20, vol: 0.002 },
  'CSCO': { name: 'Cisco Systems Inc.', isin: 'US17275R1023', currency: 'USD', price: 52.30, vol: 0.010 },
  'ZURN': { name: 'Zurich Insurance Group', isin: 'CH0011075394', currency: 'CHF', price: 512.40, vol: 0.008 },
};
const fx = { USD: 0.912, EUR: 0.987, CHF: 1.0 };
const indices = {
  'MSCI World': { value: 3210.45, vol: 0.008 },
  'S&P 500': { value: 5278.40, vol: 0.009 },
  'Euro Stoxx 50': { value: 4987.12, vol: 0.010 },
  'Swiss Market Index': { value: 11792.30, vol: 0.007 },
};
const portfolioMeta = {
  'P-1001': { name: 'Global Balanced Portfolio', mandate: 'Balanced', currency: 'CHF', cash: 2458320.45, color: '#1A56DB' },
  'P-1002': { name: 'Growth Equity Mandate', mandate: 'Growth', currency: 'CHF', cash: 842150.20, color: '#8B5CF6' },
  'P-1003': { name: 'Capital Preservation', mandate: 'Conservative', currency: 'CHF', cash: 1240000.00, color: '#059669' },
};
const positionBase = [
  { id: 'POS-1', portfolioId: 'P-1001', instrumentId: 'AAPL', assetClass: 'Equities', quantity: 1258 },
  { id: 'POS-2', portfolioId: 'P-1001', instrumentId: 'NESN', assetClass: 'Equities', quantity: 2000 },
  { id: 'POS-3', portfolioId: 'P-1001', instrumentId: 'BOND-1', assetClass: 'Fixed Income', quantity: 10000 },
  { id: 'POS-4', portfolioId: 'P-1001', instrumentId: 'MSFT', assetClass: 'Equities', quantity: 420 },
  { id: 'POS-5', portfolioId: 'P-1001', instrumentId: 'NOVN', assetClass: 'Equities', quantity: 1800 },
  { id: 'POS-6', portfolioId: 'P-1001', instrumentId: 'BOND-2', assetClass: 'Fixed Income', quantity: 5000 },
  { id: 'POS-7', portfolioId: 'P-1001', instrumentId: 'ZURN', assetClass: 'Equities', quantity: 150 },
  { id: 'POS-8', portfolioId: 'P-1002', instrumentId: 'AAPL', assetClass: 'Equities', quantity: 850 },
  { id: 'POS-9', portfolioId: 'P-1002', instrumentId: 'MSFT', assetClass: 'Equities', quantity: 620 },
  { id: 'POS-10', portfolioId: 'P-1002', instrumentId: 'GOOGL', assetClass: 'Equities', quantity: 480 },
  { id: 'POS-11', portfolioId: 'P-1002', instrumentId: 'CSCO', assetClass: 'Equities', quantity: 3200 },
  { id: 'POS-12', portfolioId: 'P-1002', instrumentId: 'NOVN', assetClass: 'Equities', quantity: 900 },
  { id: 'POS-13', portfolioId: 'P-1002', instrumentId: 'ROG', assetClass: 'Equities', quantity: 420 },
  { id: 'POS-14', portfolioId: 'P-1003', instrumentId: 'BOND-1', assetClass: 'Fixed Income', quantity: 20000 },
  { id: 'POS-15', portfolioId: 'P-1003', instrumentId: 'BOND-2', assetClass: 'Fixed Income', quantity: 15000 },
  { id: 'POS-16', portfolioId: 'P-1003', instrumentId: 'BOND-3', assetClass: 'Fixed Income', quantity: 8000 },
  { id: 'POS-17', portfolioId: 'P-1003', instrumentId: 'NESN', assetClass: 'Equities', quantity: 500 },
  { id: 'POS-18', portfolioId: 'P-1003', instrumentId: 'ZURN', assetClass: 'Equities', quantity: 80 },
];
const costBasis = { 'AAPL': 178, 'NESN': 88, 'BOND-1': 100, 'MSFT': 380, 'NOVN': 84, 'GOOGL': 155, 'ROG': 230, 'UBS': 25, 'BOND-2': 98, 'BOND-3': 99.5, 'CSCO': 48, 'ZURN': 480 };
const transactions = [
  { id: 'TX-1', portfolioId: 'P-1001', tradeDate: '2025-05-23', settlementDate: '2025-05-27', type: 'BUY', instrument: 'Apple Inc.', instrumentId: 'AAPL', quantity: 150, price: 195.42, currency: 'USD', amountChf: -26423.70, account: 'Personal 12345678', status: 'SETTLED' },
  { id: 'TX-2', portfolioId: 'P-1001', tradeDate: '2025-05-22', settlementDate: '2025-05-26', type: 'SELL', instrument: 'Nestlé SA', instrumentId: 'NESN', quantity: 200, price: 92.18, currency: 'CHF', amountChf: 18436.00, account: 'Personal 12345678', status: 'SETTLED' },
  { id: 'TX-3', portfolioId: 'P-1001', tradeDate: '2025-05-20', settlementDate: '2025-05-20', type: 'DIVIDEND', instrument: 'Novartis AG', instrumentId: 'NOVN', quantity: null, price: null, currency: 'CHF', amountChf: 246.80, account: 'Personal 12345678', status: 'BOOKED' },
  { id: 'TX-4', portfolioId: 'P-1002', tradeDate: '2025-05-21', settlementDate: '2025-05-25', type: 'BUY', instrument: 'Alphabet Inc.', instrumentId: 'GOOGL', quantity: 80, price: 175.80, currency: 'USD', amountChf: -12825.98, account: 'Growth 98765432', status: 'SETTLED' },
  { id: 'TX-5', portfolioId: 'P-1003', tradeDate: '2025-05-19', settlementDate: '2025-05-23', type: 'BUY', instrument: 'Swiss Conf.', instrumentId: 'BOND-1', quantity: 2000, price: 98.23, currency: 'CHF', amountChf: -196460, account: 'Preservation 11223344', status: 'SETTLED' },
];

function gbmTick(price, vol) {
  const dt = 3 / (252 * 8 * 3600);
  const z = Math.sqrt(-2 * Math.log(Math.random())) * Math.cos(2 * Math.PI * Math.random());
  return price * Math.exp(-0.5 * vol * vol * dt + vol * Math.sqrt(dt) * z);
}

function getLivePositions(portfolioId) {
  return positionBase.filter(p => p.portfolioId === portfolioId).map(p => {
    const inst = instruments[p.instrumentId], fxRate = fx[inst.currency] || 1;
    const mv = p.quantity * inst.price * fxRate, cost = p.quantity * (costBasis[p.instrumentId] || inst.price) * fxRate;
    return { id: p.id, portfolioId: p.portfolioId, instrumentId: p.instrumentId, name: inst.name, isin: inst.isin, assetClass: p.assetClass, currency: inst.currency, quantity: p.quantity, price: +inst.price.toFixed(4), marketValueChf: +mv.toFixed(2), unrealizedPlChf: +(mv - cost).toFixed(2) };
  });
}

function getLivePortfolio(portfolioId) {
  const meta = portfolioMeta[portfolioId]; if (!meta) return null;
  const positions = getLivePositions(portfolioId);
  const investedValue = positions.reduce((s, p) => s + p.marketValueChf, 0);
  const totalValue = investedValue + meta.cash, prevValue = totalValue * 0.9801;
  const byClass = {};
  for (const p of positions) byClass[p.assetClass] = (byClass[p.assetClass] || 0) + p.marketValueChf;
  byClass['Cash & Money Market'] = (byClass['Cash & Money Market'] || 0) + meta.cash;
  const allocation = Object.entries(byClass).map(([assetClass, valueChf]) => ({ assetClass, pct: +((valueChf / totalValue) * 100).toFixed(1), valueChf: +valueChf.toFixed(0) }));
  return { id: portfolioId, name: meta.name, mandate: meta.mandate, baseCurrency: meta.currency, color: meta.color, value: +totalValue.toFixed(2), dayChange: +(totalValue - prevValue).toFixed(2), dayChangePct: +((totalValue - prevValue) / prevValue * 100).toFixed(2), allocation };
}

function getAllPortfolios() { return Object.keys(portfolioMeta).map(id => getLivePortfolio(id)); }
function getMarketOverview() { return Object.entries(indices).map(([name, idx]) => ({ name, value: +idx.value.toFixed(2), changePct: +(((idx.value / (idx.value / 1.005)) - 1) * 100).toFixed(2) })); }
function getAggregatedDashboard() {
  const portfolios = getAllPortfolios(), totalAum = portfolios.reduce((s, p) => s + p.value, 0), totalDayChange = portfolios.reduce((s, p) => s + p.dayChange, 0);
  const portfolioAllocation = portfolios.map(p => ({ portfolioId: p.id, name: p.name, mandate: p.mandate, color: p.color, value: p.value, pct: +((p.value / totalAum) * 100).toFixed(1) }));
  const allPositions = Object.keys(portfolioMeta).flatMap(id => getLivePositions(id)), byClass = {};
  for (const p of allPositions) byClass[p.assetClass] = (byClass[p.assetClass] || 0) + p.marketValueChf;
  byClass['Cash & Money Market'] = (byClass['Cash & Money Market'] || 0) + Object.values(portfolioMeta).reduce((s, m) => s + m.cash, 0);
  const assetAllocation = Object.entries(byClass).map(([assetClass, valueChf]) => ({ assetClass, pct: +((valueChf / totalAum) * 100).toFixed(1), valueChf: +valueChf.toFixed(0) }));
  return { totalAum: +totalAum.toFixed(2), totalDayChange: +totalDayChange.toFixed(2), totalDayChangePct: +((totalDayChange / (totalAum - totalDayChange)) * 100).toFixed(2), portfolios, portfolioAllocation, assetAllocation, marketOverview: getMarketOverview(), recentActivity: transactions.slice(0, 5), unreadNotifications: 0 };
}

// ── FCM persistence ───────────────────────────────────────────────────────────
const TOKENS_FILE = '/tmp/fcm_tokens.json';
let fcmTokens = {};
try { if (fs.existsSync(TOKENS_FILE)) fcmTokens = JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf-8')); console.log(`Loaded ${Object.keys(fcmTokens).length} FCM token(s)`); } catch (e) { }
function saveTokens() { try { fs.writeFileSync(TOKENS_FILE, JSON.stringify(fcmTokens)); } catch (e) { } }

// ── In-memory stores ──────────────────────────────────────────────────────────
const authChallenges = {}, beneficiaries = {}, payments = {}, connectedClients = new Set();
function broadcast(payload) { const msg = JSON.stringify(payload); for (const ws of connectedClients) if (ws.readyState === 1) ws.send(msg); }

// ── Simulation ────────────────────────────────────────────────────────────────
setInterval(() => {
  const priceChanges = [];
  for (const [id, inst] of Object.entries(instruments)) { const prev = inst.price; inst.price = gbmTick(inst.price, inst.vol); priceChanges.push({ instrumentId: id, prev: +prev.toFixed(4), price: +inst.price.toFixed(4), currency: inst.currency }); }
  for (const idx of Object.values(indices)) idx.value = gbmTick(idx.value, idx.vol);
  const portfolios = getAllPortfolios(), totalAum = portfolios.reduce((s, p) => s + p.value, 0);
  broadcast({ eventId: 'EVT-' + Date.now(), source: 'MARKET_DATA', eventType: 'PRICE_UPDATED', occurredAt: now(), payload: { prices: priceChanges, portfolios, totalAum: +totalAum.toFixed(2), marketOverview: getMarketOverview() } });
}, 3000);

// ── Auth endpoints ────────────────────────────────────────────────────────────
app.post('/api/v1/auth/login', (req, res) => {
  const { username, password } = req.body, user = users.find(u => u.username === username && u.password === password);
  if (!user) return res.status(401).json({ error: { code: 'AUTH_FAILED', message: 'Invalid credentials' } });
  const token = Buffer.from(JSON.stringify({ userId: user.id, role: user.role })).toString('base64');
  res.json({ accessToken: token, tokenType: 'Bearer', expiresIn: 3600, user: { id: user.id, name: user.name, role: user.role } });
});

app.get('/api/v1/clients/me/config', authenticate, (req, res) => {
  const config = clientConfig[req.user.userId];
  res.json({ data: config || { coSignThreshold: null, rmThreshold: null, coSignerId: null, coSignerName: null } });
});

app.post('/auth/fcm-token', authenticate, (req, res) => {
  const { fcmToken } = req.body; if (!fcmToken) return res.status(400).json({ error: 'Missing fcmToken' });
  fcmTokens[req.user.userId] = fcmToken; saveTokens();
  console.log(`FCM token registered for user ${req.user.userId}`);
  res.json({ success: true });
});

app.post('/auth/web-challenge', async (req, res) => {
  const { username, password } = req.body, user = users.find(u => u.username === username && u.password === password);
  if (!user) return res.status(401).json({ error: { code: 'AUTH_FAILED', message: 'Invalid credentials' } });
  const fcmToken = fcmTokens[user.id];
  if (!fcmToken) return res.status(400).json({ error: { code: 'NO_MOBILE_DEVICE', message: 'No mobile device registered. Please log in via the mobile app first.' } });
  const challengeId = 'CHG-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9), expiresAt = Date.now() + 3 * 60 * 1000;
  authChallenges[challengeId] = { userId: user.id, status: 'PENDING', expiresAt, ipAddress: req.headers['x-forwarded-for'] || req.ip || 'Unknown', createdAt: now() };
  await sendPush(fcmToken, { title: '🔐 New login request', body: 'Someone is trying to log into your account. Tap to approve or reject.', data: { type: 'WEB_LOGIN_CHALLENGE', challengeId, userName: user.name, ipAddress: authChallenges[challengeId].ipAddress, timestamp: authChallenges[challengeId].createdAt } });
  res.json({ challengeId, expiresAt });
});

app.get('/auth/web-challenge/:id/status', (req, res) => {
  const c = authChallenges[req.params.id]; if (!c) return res.status(404).json({ error: 'Not found' });
  if (Date.now() > c.expiresAt) c.status = 'EXPIRED';
  if (c.status === 'APPROVED') {
    const user = users.find(u => u.id === c.userId), token = Buffer.from(JSON.stringify({ userId: user.id, role: user.role })).toString('base64');
    delete authChallenges[req.params.id];
    return res.json({ status: 'APPROVED', accessToken: token, user: { id: user.id, name: user.name, role: user.role } });
  }
  res.json({ status: c.status, expiresAt: c.expiresAt });
});

app.post('/auth/web-challenge/:id/approve', authenticate, (req, res) => {
  const c = authChallenges[req.params.id]; if (!c) return res.status(404).json({ error: 'Not found' });
  if (Date.now() > c.expiresAt) return res.status(400).json({ error: 'Expired' });
  if (c.userId !== req.user.userId) return res.status(403).json({ error: 'Forbidden' });
  c.status = 'APPROVED'; res.json({ success: true });
});

app.post('/auth/web-challenge/:id/reject', authenticate, (req, res) => {
  const c = authChallenges[req.params.id]; if (!c) return res.status(404).json({ error: 'Not found' });
  if (c.userId !== req.user.userId) return res.status(403).json({ error: 'Forbidden' });
  c.status = 'REJECTED'; delete authChallenges[req.params.id]; res.json({ success: true });
});

// ── Portfolio endpoints ───────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', version: SERVER_VERSION, service: 'private-banking-pi', firebase: firebaseInitialized, uptime: Math.floor(process.uptime()), timestamp: now() }));
app.get('/bff/mobile/dashboard', (req, res) => res.json(response(getAggregatedDashboard())));
app.get('/portfolios', (req, res) => res.json(response(getAllPortfolios())));
app.get('/portfolios/:id', (req, res) => res.json(response(getLivePortfolio(req.params.id))));
app.get('/portfolios/:id/positions', (req, res) => {
  const positions = getLivePositions(req.params.id), portfolio = getLivePortfolio(req.params.id);
  if (!portfolio) return res.status(404).json({ error: 'Not found' });
  res.json(response(positions.map(p => ({ ...p, weightPct: +((p.marketValueChf / portfolio.value) * 100).toFixed(2) }))));
});
app.get('/portfolios/:id/performance', (req, res) => res.json(response({ portfolioId: req.params.id, twr: { mtd: 1.25, ytd: 7.62, oneYear: 12.35, threeYearAnnualized: 8.91 }, mwr: { ytd: 7.10, sinceInception: 7.85 }, benchmark: { name: 'MSCI World', ytd: 5.18 }, excessReturnYtd: 2.44 })));
app.get('/portfolios/:id/allocation', (req, res) => res.json(response(getLivePortfolio(req.params.id)?.allocation || [])));
app.get('/portfolios/:id/profitability', (req, res) => {
  const positions = getLivePositions(req.params.id), unrealized = positions.reduce((s, p) => s + p.unrealizedPlChf, 0);
  res.json(response({ portfolioId: req.params.id, realizedPlChf: 245678.90, unrealizedPlChf: +unrealized.toFixed(2), incomeChf: 78342.15, feesChf: -23456.78, totalNetProfitabilityChf: +(unrealized + 245678.90 + 78342.15 - 23456.78).toFixed(2) }));
});
app.get('/portfolios/:id/cash', (req, res) => res.json(response({ portfolioId: req.params.id, totalCashChf: 2458320.45, availableToInvestChf: 1985410.22, pendingChf: 312450.13, restrictedChf: 160460.10, currencies: [{ currency: 'CHF', total: 1250450.10, valueChf: 1250450.10, pct: 50.9 }, { currency: 'USD', total: 895210.35, valueChf: 816422.71, pct: 33.2 }, { currency: 'EUR', total: 210430.80, valueChf: 207640.77, pct: 8.4 }] })));
app.get('/transactions', (req, res) => { const { portfolioId } = req.query; res.json(response(portfolioId ? transactions.filter(t => t.portfolioId === portfolioId) : transactions)); });
app.get('/marketdata/indices', (req, res) => res.json(response(getMarketOverview())));
app.get('/notifications', (req, res) => res.json(response([])));

// ── Beneficiaries ─────────────────────────────────────────────────────────────
app.get('/beneficiaries', authenticate, (req, res) => res.json({ data: beneficiaries[req.user.userId] || [] }));

app.post('/beneficiaries', authenticate, async (req, res) => {
  const { beneficiaryName, iban, bankName, bankCountry, currency } = req.body;
  if (!beneficiaryName || !iban) return res.status(400).json({ error: 'Missing required fields' });
  const user = users.find(u => u.id === req.user.userId), beneficiaryId = 'BEN-' + Date.now();
  if (!beneficiaries[req.user.userId]) beneficiaries[req.user.userId] = [];
  const beneficiary = { id: beneficiaryId, beneficiaryName, iban, bankName: bankName || '', bankCountry: bankCountry || '', currency: currency || 'CHF', status: 'PENDING_APPROVAL', requestedAt: now(), customerId: req.user.userId, customerName: user.name };
  beneficiaries[req.user.userId].push(beneficiary);
  try {
    const proc = await flowable('POST', '/runtime/process-instances', {
      processDefinitionKey: 'beneficiaryRegistration', businessKey: beneficiaryId, variables: [
        { name: 'beneficiaryId', value: beneficiaryId, type: 'string' }, { name: 'beneficiaryName', value: beneficiaryName, type: 'string' },
        { name: 'iban', value: iban, type: 'string' }, { name: 'bankName', value: bankName || '', type: 'string' },
        { name: 'bankCountry', value: bankCountry || '', type: 'string' }, { name: 'currency', value: currency || 'CHF', type: 'string' },
        { name: 'customerId', value: req.user.userId, type: 'string' }, { name: 'customerName', value: user.name, type: 'string' },
        { name: 'requestedAt', value: now(), type: 'string' },
      ]
    });
    beneficiary.processInstanceId = proc.id;
    console.log(`Beneficiary process started: ${proc.id}`);
  } catch (e) { console.error('Flowable error:', e.message); }
  res.status(201).json({ data: beneficiary });
});

app.get('/beneficiaries/:id', authenticate, (req, res) => {
  const b = (beneficiaries[req.user.userId] || []).find(b => b.id === req.params.id);
  if (!b) return res.status(404).json({ error: 'Not found' });
  res.json({ data: b });
});

app.delete('/beneficiaries/:id', authenticate, (req, res) => {
  const list = beneficiaries[req.user.userId] || [], idx = list.findIndex(b => b.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  list.splice(idx, 1); res.json({ success: true });
});

// ── Payments ──────────────────────────────────────────────────────────────────
app.get('/payments', authenticate, (req, res) => {
  const userPayments = Object.values(payments).filter(p => p.customerId === req.user.userId || p.coSignerId === req.user.userId);
  res.json({ data: userPayments.sort((a, b) => new Date(b.initiatedAt) - new Date(a.initiatedAt)) });
});

app.post('/payments', authenticate, async (req, res) => {
  const { beneficiaryId, amount, currency, reference, portfolioId } = req.body;
  if (!beneficiaryId || !amount) return res.status(400).json({ error: 'Missing required fields' });
  const user = users.find(u => u.id === req.user.userId), config = clientConfig[req.user.userId];
  const bList = beneficiaries[req.user.userId] || [], beneficiary = bList.find(b => b.id === beneficiaryId && b.status === 'ACTIVE');
  if (!beneficiary) return res.status(400).json({ error: 'Beneficiary not found or not active' });
  const paymentId = 'PAY-' + Date.now(), amountNum = parseFloat(amount);
  const coSignTh = config?.coSignThreshold || 10000, rmTh = config?.rmThreshold || 50000;
  const payment = {
    id: paymentId, customerId: req.user.userId, customerName: user.name,
    coSignerId: config?.coSignerId || null, coSignerName: config?.coSignerName || null,
    beneficiaryId, beneficiaryName: beneficiary.beneficiaryName, iban: beneficiary.iban, bankName: beneficiary.bankName,
    amount: amountNum, currency: currency || beneficiary.currency || 'CHF', reference: reference || '',
    portfolioId: portfolioId || user.portfolios?.[0] || 'P-1001', status: 'PENDING',
    approvalPath: amountNum <= coSignTh ? 'STRAIGHT_THROUGH' : amountNum <= rmTh ? 'CO_SIGNER' : 'CO_SIGNER_AND_RM',
    initiatedAt: now(),
  };
  payments[paymentId] = payment;
  try {
    const proc = await flowable('POST', '/runtime/process-instances', {
      processDefinitionKey: 'paymentApproval', businessKey: paymentId, variables: [
        { name: 'paymentId', value: paymentId, type: 'string' }, { name: 'customerId', value: req.user.userId, type: 'string' },
        { name: 'customerName', value: user.name, type: 'string' }, { name: 'coSignerId', value: config?.coSignerId || '', type: 'string' },
        { name: 'coSignerName', value: config?.coSignerName || '', type: 'string' }, { name: 'beneficiaryId', value: beneficiaryId, type: 'string' },
        { name: 'beneficiaryName', value: beneficiary.beneficiaryName, type: 'string' }, { name: 'iban', value: beneficiary.iban, type: 'string' },
        { name: 'bankName', value: beneficiary.bankName || '', type: 'string' }, { name: 'amount', value: amountNum, type: 'double' },
        { name: 'currency', value: payment.currency, type: 'string' }, { name: 'reference', value: payment.reference, type: 'string' },
        { name: 'portfolioId', value: payment.portfolioId, type: 'string' },
      ]
    });
    payment.processInstanceId = proc.id;
    console.log(`Payment process started: ${proc.id} for ${paymentId} (${amountNum} ${payment.currency})`);
  } catch (e) { console.error('Payment Flowable error:', e.message); }
  if (amountNum > coSignTh && config?.coSignerId) {
    const tok = fcmTokens[config.coSignerId];
    if (tok) await sendPush(tok, { title: '💳 Payment Approval Required', body: `${user.name} wants to send ${payment.currency} ${amountNum.toLocaleString()} to ${beneficiary.beneficiaryName}`, data: { type: 'PAYMENT_CO_SIGN', paymentId, customerId: req.user.userId, amount: String(amountNum), currency: payment.currency, beneficiaryName: beneficiary.beneficiaryName, iban: beneficiary.iban, customerName: user.name, reference: payment.reference } });
  }
  res.status(201).json({ data: payment });
});

app.get('/payments/pending/cosign', authenticate, async (req, res) => {
  try {
    const data = await flowable('GET', `/runtime/tasks?assignee=${req.user.userId}&processDefinitionKey=paymentApproval&size=50`);
    const tasks = await Promise.all((data.data || []).map(async task => {
      try { const vars = await flowable('GET', `/runtime/process-instances/${task.processInstanceId}/variables`); const varMap = {}; (vars || []).forEach(v => varMap[v.name] = v.value); return { taskId: task.id, ...varMap }; }
      catch { return { taskId: task.id }; }
    }));
    res.json({ data: tasks });
  } catch (e) { res.status(502).json({ error: 'Flowable unavailable' }); }
});

app.post('/payments/:paymentId/cosign', authenticate, async (req, res) => {
  const { decision, comment } = req.body, payment = payments[req.params.paymentId];
  if (!payment) return res.status(404).json({ error: 'Payment not found' });
  if (payment.coSignedAt) return res.status(400).json({ error: 'Payment already co-signed' });
  payment.coSignedAt = now(); payment.coSignedBy = req.user.userId; payment.status = 'CO_SIGNED';
  res.json({ success: true, decision });
  setImmediate(async () => {
    try {
      const data = await flowable('GET', `/runtime/tasks?processInstanceId=${payment.processInstanceId}&size=10`);
      const task = (data.data || []).find(t => t.name === 'Co-Signer Approval');
      if (!task) { console.error('Co-sign task not found for', req.params.paymentId); return; }
      await flowable('POST', `/runtime/tasks/${task.id}`, {
        action: 'complete', variables: [
          { name: 'coSignerDecision', value: decision, type: 'string' }, { name: 'coSignerComment', value: comment || '', type: 'string' },
          { name: 'coSignedAt', value: now(), type: 'string' }, { name: 'coSignedBy', value: req.user.userId, type: 'string' },
        ]
      });
      console.log(`Co-sign task ${task.id} completed: ${decision} for payment ${req.params.paymentId}`);
    } catch (e) { console.error('Co-sign background error:', e.message); }
  });
});

// ── Workflow tasks ────────────────────────────────────────────────────────────
app.get('/workflow/tasks', authenticate, async (req, res) => {
  try {
    const [beneficiaryData, paymentData, documentData] = await Promise.all([
      flowable('GET', '/runtime/tasks?processDefinitionKey=beneficiaryRegistration&size=50'),
      flowable('GET', '/runtime/tasks?processDefinitionKey=paymentApproval&size=50'),
      flowable('GET', '/runtime/tasks?processDefinitionKey=paymentDocumentApproval&size=50'),
    ]);
    const allTasks = [...(beneficiaryData.data || []), ...(paymentData.data || []), ...(documentData.data || [])];
    const tasks = await Promise.all(allTasks.map(async task => {
      try { const vars = await flowable('GET', `/runtime/process-instances/${task.processInstanceId}/variables`); const varMap = {}; (vars || []).forEach(v => varMap[v.name] = v.value); return { ...task, variables: varMap }; }
      catch { return { ...task, variables: {} }; }
    }));
    const allowedTasks = roleTaskMap[req.user.role] || null;
    const filtered = allowedTasks ? tasks.filter(t => allowedTasks.includes(t.taskDefinitionKey)) : tasks;
    res.json({ data: filtered, total: filtered.length });
  } catch (e) { console.error('Flowable tasks error:', e.message); res.status(502).json({ error: 'Flowable unavailable', detail: e.message }); }
});

app.get('/workflow/tasks/:taskId', authenticate, async (req, res) => {
  try {
    const task = await flowable('GET', `/runtime/tasks/${req.params.taskId}`);
    const vars = await flowable('GET', `/runtime/process-instances/${task.processInstanceId}/variables`);
    const varMap = {}; (vars || []).forEach(v => varMap[v.name] = v.value);
    res.json({ data: { ...task, variables: varMap } });
  } catch (e) { res.status(502).json({ error: 'Flowable unavailable' }); }
});

app.post('/workflow/tasks/:taskId/complete', authenticate, async (req, res) => {
  const { decision, staffComment } = req.body;
  if (!decision) return res.status(400).json({ error: 'decision required' });
  res.json({ success: true, decision });
  setImmediate(async () => {
    try {
      const task = await flowable('GET', `/runtime/tasks/${req.params.taskId}`);
      const taskKey = task.taskDefinitionKey;
      const decisionVar = taskKey === 'coSignerApproval' ? 'coSignerDecision' : taskKey === 'rmApproval' ? 'rmDecision' : 'decision';
      const commentVar = taskKey === 'rmApproval' ? 'rmComment' : 'staffComment';
      await flowable('POST', `/runtime/tasks/${req.params.taskId}`, {
        action: 'complete', variables: [
          { name: decisionVar, value: decision, type: 'string' }, { name: commentVar, value: staffComment || '', type: 'string' },
          { name: 'reviewedBy', value: req.user.userId, type: 'string' }, { name: 'reviewedAt', value: now(), type: 'string' },
        ]
      });
      console.log(`Task ${req.params.taskId} completed: ${decision} (${taskKey})`);

      // Fetch historic variables
      const histVars = await flowable('GET', `/history/historic-variable-instances?processInstanceId=${task.processInstanceId}`);
      const varMap = {};
      (histVars?.data || []).forEach(v => { const name = v.variable?.name ?? v.variableName, value = v.variable?.value ?? v.value; if (name) varMap[name] = value; });

      const paymentId = varMap.paymentId, beneficiaryName = varMap.beneficiaryName, customerId = varMap.customerId;

      // Beneficiary notification
      if (beneficiaryName && !paymentId) {
        const iban = varMap.iban || '';
        const notificationType = decision === 'APPROVE' ? 'BENEFICIARY_APPROVED' : 'BENEFICIARY_REJECTED_STAFF';
        const list = Object.values(beneficiaries).flat(), b = list.find(b => b.beneficiaryName === beneficiaryName && b.iban === iban);
        if (b) { b.status = decision === 'APPROVE' ? 'ACTIVE' : 'REJECTED'; b.resolvedAt = now(); if (staffComment) b.staffComment = staffComment; broadcast({ eventType: 'BENEFICIARY_UPDATED', payload: b, occurredAt: now() }); }
        const fcmToken = fcmTokens[customerId];
        if (fcmToken) {
          const msgs = { BENEFICIARY_APPROVED: { title: '✅ Beneficiary Approved', body: `${beneficiaryName} is now active.` }, BENEFICIARY_REJECTED_STAFF: { title: '❌ Beneficiary Registration Declined', body: `${beneficiaryName} was declined.${staffComment ? ' Reason: ' + staffComment : ''}` } };
          if (msgs[notificationType]) await sendPush(fcmToken, { ...msgs[notificationType], data: { type: notificationType, beneficiaryName, iban, customerId } });
        }
      }

      // Payment notifications
      if (paymentId) {
        const payment = payments[paymentId];
        if (decision === 'REJECT') {
          // Rejected by RM or co-signer
          if (payment) { payment.status = 'REJECTED'; payment.resolvedAt = now(); broadcast({ eventType: 'PAYMENT_UPDATED', payload: payment, occurredAt: now() }); }
          const fcmToken = fcmTokens[customerId];
          const rejectedBy = taskKey === 'rmApproval' ? 'your Relationship Manager' : 'co-signer';
          if (fcmToken && payment) await sendPush(fcmToken, { title: '❌ Payment Declined', body: `Your payment to ${payment.beneficiaryName} was declined by ${rejectedBy}.${staffComment ? ' Reason: ' + staffComment : ''}`, data: { type: taskKey === 'rmApproval' ? 'PAYMENT_REJECTED_RM' : 'PAYMENT_REJECTED_COSIGNER', paymentId, customerId } });
        } else if (decision === 'APPROVE' && (taskKey === 'rmApproval' || (taskKey === 'coSignerApproval' && payment?.approvalPath === 'CO_SIGNER'))) {
          // Approved — execute payment
          if (payment) { payment.status = 'EXECUTED'; payment.resolvedAt = now(); broadcast({ eventType: 'PAYMENT_UPDATED', payload: payment, occurredAt: now() }); }
          const fcmToken = fcmTokens[customerId];
          if (fcmToken && payment) await sendPush(fcmToken, { title: '✅ Payment Executed', body: `Your payment of ${payment.currency} ${payment.amount.toLocaleString()} to ${payment.beneficiaryName} has been executed.`, data: { type: 'PAYMENT_EXECUTED', paymentId, customerId, amount: String(payment.amount), currency: payment.currency, beneficiaryName: payment.beneficiaryName } });
          if (payment?.coSignerId) {
            const coSignerToken = fcmTokens[payment.coSignerId];
            if (coSignerToken) await sendPush(coSignerToken, { title: '✅ Payment Approved', body: `The payment to ${payment.beneficiaryName} has been fully approved and executed.`, data: { type: 'PAYMENT_EXECUTED', paymentId } });
          }
        }
      }
    } catch (e) { console.error('Complete task background error:', e.message); }
  });
});


// ── AI Banking Assistant (Azure OpenAI + MCP tools) ──────────────────────────
const AZURE_OPENAI_ENDPOINT = process.env.AZURE_OPENAI_ENDPOINT || 'https://hmzpoliciesevaluation.openai.azure.com/';
const AZURE_OPENAI_KEY = process.env.AZURE_OPENAI_KEY || '';
const AZURE_DEPLOYMENT = process.env.AZURE_DEPLOYMENT || 'gpt-4o';
const AZURE_API_VERSION = '2024-02-01';

const NEWS_API_KEY = process.env.NEWS_API_KEY;
const NEWS_API_BASE = "https://newsapi.org/v2/everything";


// MCP Tool definitions
const bankingTools = [
  {
    type: 'function',
    function: {
      name: 'get_portfolio_summary',
      description: 'Get aggregated portfolio summary for the client including total AUM, day change, and asset allocation',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_portfolio_detail',
      description: 'Get detailed information for a specific portfolio including positions and performance',
      parameters: {
        type: 'object',
        properties: {
          portfolio_id: { type: 'string', description: 'Portfolio ID e.g. P-1001, P-1002, P-1003' },
        },
        required: ['portfolio_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_positions',
      description: 'Get current holdings and positions for a portfolio with live prices',
      parameters: {
        type: 'object',
        properties: {
          portfolio_id: { type: 'string', description: 'Portfolio ID' },
        },
        required: ['portfolio_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_transactions',
      description: 'Get recent transaction history for the client',
      parameters: {
        type: 'object',
        properties: {
          portfolio_id: { type: 'string', description: 'Optional portfolio ID to filter transactions' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_beneficiaries',
      description: 'Get list of registered beneficiaries and their approval status',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_payments',
      description: 'Get payment history and status for the client',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_market_overview',
      description: 'Get current market indices and overview',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_client_profile',
      description: 'Get client profile information including name, portfolios and relationship manager',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_position_news_digest',
      description: 'Get recent news headlines relevant to each holding in a portfolio, matched by ticker/company name. Use when the user asks why a position or portfolio moved, or wants news on their holdings.',
      parameters: {
        type: 'object',
        properties: {
          portfolio_id: { type: 'string', description: 'Portfolio ID e.g. P-1001, P-1002, P-1003' },
          max_articles_per_holding: { type: 'integer', description: 'Max news articles per holding (default 2)' },
          top_n: { type: 'integer', description: 'If set, only fetch news for the top N holdings by absolute unrealized P&L — use this for "why did my portfolio move" questions. Omit to get news for all holdings — use this for "main news in my portfolio" questions.' },
        },
        required: ['portfolio_id'],
      },
    },
  },
];

// Execute MCP tool call
async function executeTool(toolName, args, userId) {
  switch (toolName) {
    case 'get_portfolio_summary': {
      const dashboard = getAggregatedDashboard();
      return {
        totalAum: dashboard.totalAum,
        dayChange: dashboard.totalDayChange,
        dayChangePct: dashboard.totalDayChangePct,
        portfolios: dashboard.portfolioAllocation,
        assetAllocation: dashboard.assetAllocation,
      };
    }
    case 'get_portfolio_detail': {
      const p = getLivePortfolio(args.portfolio_id);
      if (!p) return { error: `Portfolio ${args.portfolio_id} not found` };
      return p;
    }
    case 'get_positions': {
      const positions = getLivePositions(args.portfolio_id);
      const portfolio = getLivePortfolio(args.portfolio_id);
      if (!portfolio) return { error: `Portfolio ${args.portfolio_id} not found` };
      return { portfolioId: args.portfolio_id, positions, totalValue: portfolio.value };
    }
    case 'get_transactions': {
      const txns = args.portfolio_id
        ? transactions.filter(t => t.portfolioId === args.portfolio_id)
        : transactions;
      return { transactions: txns };
    }
    case 'get_beneficiaries': {
      return { beneficiaries: beneficiaries[userId] || [] };
    }
    case 'get_payments': {
      const userPayments = Object.values(payments).filter(
        p => p.customerId === userId || p.coSignerId === userId
      );
      return { payments: userPayments };
    }
    case 'get_market_overview': {
      return { markets: getMarketOverview() };
    }
    case 'get_client_profile': {
      const user = users.find(u => u.id === userId);
      const config = clientConfig[userId];
      const rm = config ? users.find(u => u.id === 'u002') : null;
      return {
        id: user?.id, name: user?.name, role: user?.role,
        portfolios: user?.portfolios || [],
        relationshipManager: rm ? { id: rm.id, name: rm.name } : null,
        coSignerName: config?.coSignerName || null,
      };
    }
    case 'get_position_news_digest': {
      return await getPositionNewsDigest(args.portfolio_id, args.max_articles_per_holding);
    }

    default:
      return { error: `Unknown tool: ${toolName}` };
  }
}

async function getPositionNewsDigest(portfolioId, { maxArticlesPerHolding = 2, topN = null } = {}) {
  const portfolio = getLivePortfolio(portfolioId);
  if (!portfolio) return { error: `Portfolio ${portfolioId} not found` };

  let positions = getLivePositions(portfolioId);

  // topN: only fetch news for the biggest movers, not every holding
  if (topN) {
    positions = [...positions]
      .sort((a, b) => Math.abs(b.unrealizedPlChf) - Math.abs(a.unrealizedPlChf))
      .slice(0, topN);
  }

  const holdings = await Promise.all(
    positions.map(async (position) => {
      const articles = await fetchNewsForQuery(position.name, maxArticlesPerHolding);
      return {
        isin: position.isin,
        name: position.name,
        assetClass: position.assetClass,
        marketValueChf: position.marketValueChf,
        unrealizedPlChf: position.unrealizedPlChf,
        news: articles,
      };
    })
  );

  return {
    portfolioId,
    portfolioDayChange: portfolio.dayChange,
    portfolioDayChangePct: portfolio.dayChangePct,
    generatedAt: new Date().toISOString(),
    holdings,
  };
}

const NEWS_CACHE = new Map(); // key: query string, value: { articles, expiresAt }
const NEWS_CACHE_TTL_MS = 15 * 60 * 1000; // 15 min — news doesn't need to be fresher than that for a demo

async function fetchNewsForQuery(query, pageSize = 2) {
  const cached = NEWS_CACHE.get(query);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.articles;
  }

  const url = new URL(NEWS_API_BASE);
  url.searchParams.set("qInTitle", `"${query}"`);   // exact phrase, title only — cuts most noise
  url.searchParams.set("language", "en");
  url.searchParams.set("sortBy", "publishedAt");
  url.searchParams.set("pageSize", String(pageSize));
  //url.searchParams.set("domains", "reuters.com,bloomberg.com,cnbc.com,ft.com,wsj.com,marketwatch.com");
  url.searchParams.set("apiKey", NEWS_API_KEY);

  const res = await fetch(url.toString());
  if (!res.ok) {
    // Fail soft, but don't cache failures — a transient rate-limit shouldn't stick for 15 min
    return [];
  }
  const data = await res.json();
  const articles = (data.articles || []).map((a) => ({
    title: a.title,
    source: a.source?.name,
    publishedAt: a.publishedAt,
    url: a.url,
  }));

  NEWS_CACHE.set(query, { articles, expiresAt: Date.now() + NEWS_CACHE_TTL_MS });
  return articles;
}

// System prompt for the AI banking assistant
const SYSTEM_PROMPT = `You are a professional private banking assistant for PrivateBank.
You have access to real-time data about the client's portfolios, positions, payments and beneficiaries.
Always use the available tools to fetch current data before answering questions about finances.
Be concise, professional and precise. Format numbers with proper currency symbols and thousands separators.
When showing portfolio values, always mention the day change.
Never give generic financial advice — only discuss the client's actual data.
Respond in the same language as the client's message.

For news-related questions, use get_position_news_digest as follows:
- "Why has my portfolio moved / dropped / gone up?" → call with top_n set to 3-5, so you only pull news for the biggest movers by absolute P&L, then explain the move using that news.
- "What's the main news for my portfolio / holdings?" → call without top_n, so you get a broader digest across all holdings, then summarize the most relevant items.
- If a holding has no news articles returned, don't speculate on a cause — just note the position's performance and that no specific news was found.
- Always tie the news back to the specific holding it relates to; don't present headlines without connecting them to a position in the client's portfolio.`;

app.post('/api/v1/ai/chat', authenticate, async (req, res) => {
  const { messages } = req.body;
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'messages array required' });
  }
  if (!AZURE_OPENAI_KEY) {
    return res.status(503).json({ error: 'AI service not configured — set AZURE_OPENAI_KEY' });
  }

  try {
    const chatMessages = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...messages,
    ];

    let response;
    let iterations = 0;
    const maxIterations = 5;

    while (iterations < maxIterations) {
      iterations++;
      const azureRes = await fetch(
        `${AZURE_OPENAI_ENDPOINT}openai/deployments/${AZURE_DEPLOYMENT}/chat/completions?api-version=${AZURE_API_VERSION}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'api-key': AZURE_OPENAI_KEY,
          },
          body: JSON.stringify({
            messages: chatMessages,
            tools: bankingTools,
            tool_choice: 'auto',
            max_tokens: 1000,
            temperature: 0.3,
          }),
        }
      );

      if (!azureRes.ok) {
        const errText = await azureRes.text();
        throw new Error(`Azure OpenAI error ${azureRes.status}: ${errText}`);
      }

      response = await azureRes.json();
      const choice = response.choices?.[0];
      const msg = choice?.message;

      // No tool calls — final response
      if (!msg?.tool_calls || msg.tool_calls.length === 0) break;

      // Execute tool calls
      chatMessages.push(msg);
      for (const toolCall of msg.tool_calls) {
        const toolName = toolCall.function.name;
        const args = JSON.parse(toolCall.function.arguments || '{}');
        console.log(`AI tool call: ${toolName}`, args);
        const result = await executeTool(toolName, args, req.user.userId);
        chatMessages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: JSON.stringify(result),
        });
      }
    }

    const finalMsg = response?.choices?.[0]?.message;
    res.json({ data: { message: finalMsg?.content || 'No response', role: 'assistant' } });
  } catch (e) {
    console.error('AI chat error:', e.message);
    res.status(502).json({ error: 'AI service unavailable', detail: e.message });
  }
});

// ── Internal webhooks ─────────────────────────────────────────────────────────
app.post('/internal/notify', (req, res) => {
  res.json({ success: true });
  const { customerId, type, beneficiaryName, iban, staffComment } = req.body;
  console.log(`Internal notify: ${type} for ${customerId}`);
  const list = Object.values(beneficiaries).flat(), b = list.find(b => b.beneficiaryName === beneficiaryName && b.iban === iban);
  if (b) { b.status = type === 'BENEFICIARY_APPROVED' ? 'ACTIVE' : 'REJECTED'; b.resolvedAt = now(); if (staffComment) b.staffComment = staffComment; broadcast({ eventType: 'BENEFICIARY_UPDATED', payload: b, occurredAt: now() }); }
  const fcmToken = fcmTokens[customerId];
  if (fcmToken) {
    const msgs = { BENEFICIARY_APPROVED: { title: '✅ Beneficiary Approved', body: `${beneficiaryName} is now active.` }, BENEFICIARY_REJECTED_IBAN: { title: '❌ Beneficiary Registration Failed', body: `Invalid IBAN for ${beneficiaryName}.` }, BENEFICIARY_REJECTED_SANCTIONS: { title: '❌ Beneficiary Registration Failed', body: `${beneficiaryName} could not be approved.` }, BENEFICIARY_REJECTED_STAFF: { title: '❌ Beneficiary Registration Declined', body: `${beneficiaryName} was declined.${staffComment ? ' Reason: ' + staffComment : ''}` } };
    const msg = msgs[type]; if (msg) sendPush(fcmToken, { ...msg, data: { type, beneficiaryName, iban, customerId } });
  }
});

app.post('/internal/payment-notify', (req, res) => {
  res.json({ success: true });
  const { paymentId, customerId, coSignerId, type, amount, currency, beneficiaryName } = req.body;
  console.log(`Payment notify: ${type} for ${paymentId}`);
  const payment = payments[paymentId];
  if (payment) { payment.status = type === 'PAYMENT_EXECUTED' ? 'EXECUTED' : 'REJECTED'; payment.resolvedAt = now(); broadcast({ eventType: 'PAYMENT_UPDATED', payload: payment, occurredAt: now() }); }
  const amountFmt = `${currency} ${parseFloat(amount || 0).toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
  const customerToken = fcmTokens[customerId];
  if (customerToken) {
    const msgs = { PAYMENT_EXECUTED: { title: '✅ Payment Executed', body: `${amountFmt} to ${beneficiaryName} has been executed.` }, PAYMENT_REJECTED_COSIGNER: { title: '❌ Payment Declined', body: `Your payment of ${amountFmt} to ${beneficiaryName} was declined by co-signer.` }, PAYMENT_REJECTED_RM: { title: '❌ Payment Declined', body: `Your payment of ${amountFmt} to ${beneficiaryName} was declined by RM.` } };
    const msg = msgs[type]; if (msg) sendPush(customerToken, { ...msg, data: { type, paymentId, amount: String(amount || 0), currency, beneficiaryName } });
  }
  if (coSignerId && type === 'PAYMENT_EXECUTED') { const tok = fcmTokens[coSignerId]; if (tok) sendPush(tok, { title: '✅ Payment Approved', body: `Your approval of ${amountFmt} to ${beneficiaryName} was processed.`, data: { type, paymentId } }); }
});

app.post('/internal/pdf-notify', (req, res) => {
  res.json({ success: true });
  const { instanceId, type, title, initiatorId, nextRole } = req.body;
  const roleToUser = { rm: 'u002', customer: 'u002', compliance: 'u005' };
  const targetUserId = roleToUser[nextRole] || initiatorId, fcmToken = fcmTokens[targetUserId];
  const msgs = { PDF_INSTANCE_CREATED: { title: '📄 Document Created', body: `A new ${title} requires your input.` }, PDF_ROLE_COMPLETED: { title: '📋 Document Ready for Review', body: `${title} is ready for your validation.` }, PDF_INSTANCE_COMPLETED: { title: '✅ Document Completed', body: `${title} has been fully validated.` } };
  if (fcmToken && msgs[type]) sendPush(fcmToken, { ...msgs[type], data: { type, instanceId, title: title || '' } });
  if (type === 'PDF_INSTANCE_COMPLETED' && initiatorId) { const tok = fcmTokens[initiatorId]; if (tok) sendPush(tok, { title: '✅ Document Completed', body: `${title} has been fully processed.`, data: { type, instanceId } }); }
});

app.post('/internal/validate-iban', (req, res) => {
  const clean = (req.body.iban || '').replace(/\s/g, '').toUpperCase();
  res.json({ valid: /^[A-Z]{2}[0-9]{2}[A-Z0-9]{4}[0-9]{7}([A-Z0-9]?){0,16}$/.test(clean), iban: clean });
});



// ── Process definition steps ──────────────────────────────────────────────────
// Returns ordered user tasks from the BPMN process definition
app.get('/workflow/process-definition/:key/steps', authenticate, async (req, res) => {
  try {
    // Get latest process definition
    const defData = await flowable('GET',
      `/repository/process-definitions?key=${req.params.key}&sort=version&order=desc&size=1`);
    const def = (defData?.data || [])[0];
    if (!def) return res.status(404).json({ error: 'Process definition not found' });

    // Get model (BPMN XML)
    const modelData = await flowable('GET',
      `/repository/process-definitions/${def.id}/model`);

    // Parse user tasks from the model JSON
    // Flowable returns a JSON representation of the BPMN
    const steps = [];

    function extractTasks(element) {
      if (!element) return;
      // User tasks
      if (element.type === 'StartNoneEvent' || element.resourceType === 'StartNoneEvent') {
        steps.push({ key: 'start', name: 'Start', type: 'startEvent', assignee: null, candidateGroups: [] });
      }
      if (element.resourceType === 'UserTask' || element.type === 'UserTask') {
        steps.push({
          key: element.id || element.resourceId,
          name: element.name || element.id,
          type: 'userTask',
          assignee: element.assignee || null,
          candidateGroups: element.candidateGroups || [],
        });
      }
      // Recurse into child elements
      if (element.childShapes) element.childShapes.forEach(extractTasks);
    }

    if (modelData) extractTasks(modelData);

    // If model parsing didn't work, fall back to historic activity instances
    // from completed process instances of this definition
    if (steps.filter(s => s.type === 'userTask').length === 0) {
      const histProc = await flowable('GET',
        `/history/historic-process-instances?processDefinitionKey=${req.params.key}&finished=true&size=1`);
      const sample = (histProc?.data || [])[0];
      if (sample) {
        const activities = await flowable('GET',
          `/history/historic-activity-instances?processInstanceId=${sample.id}&activityType=userTask&size=50`);
        const seen = new Set();
        (activities?.data || [])
          .sort((a, b) => new Date(a.startTime) - new Date(b.startTime))
          .forEach(a => {
            if (!seen.has(a.activityId)) {
              seen.add(a.activityId);
              steps.push({
                key: a.activityId,
                name: a.activityName || a.activityId,
                type: 'userTask',
                assignee: a.assignee || null,
                candidateGroups: [],
              });
            }
          });
      }
    }

    res.json({
      data: {
        processKey: req.params.key,
        processName: def.name,
        version: def.version,
        steps: steps.filter(s => s.type === 'userTask'),
      }
    });
  } catch (e) {
    console.error('Process definition steps error:', e.message);
    res.status(502).json({ error: 'Flowable unavailable', detail: e.message });
  }
});

// ── Process activity history ───────────────────────────────────────────────────
// Returns all activities for a process instance (for visualizer)
app.get('/workflow/process/:processInstanceId/activities', authenticate, async (req, res) => {
  try {
    const [activities, currentTasks] = await Promise.all([
      flowable('GET',
        `/history/historic-activity-instances?processInstanceId=${req.params.processInstanceId}&activityType=userTask&size=50`),
      flowable('GET',
        `/runtime/tasks?processInstanceId=${req.params.processInstanceId}&size=10`),
    ]);

    const completed = (activities?.data || [])
      .filter(a => a.endTime)
      .map(a => ({
        key: a.activityId,
        name: a.activityName,
        status: 'COMPLETED',
        startTime: a.startTime,
        endTime: a.endTime,
        assignee: a.assignee,
        durationMs: a.durationInMillis,
      }));

    const active = (currentTasks?.data || []).map(t => ({
      key: t.taskDefinitionKey,
      name: t.name,
      status: 'ACTIVE',
      startTime: t.createTime,
      endTime: null,
      assignee: t.assignee || null,
    }));

    res.json({ data: { completed, active } });
  } catch (e) {
    res.status(502).json({ error: 'Flowable unavailable' });
  }
});

// ── Process status endpoint ───────────────────────────────────────────────────
app.get('/workflow/process/:processInstanceId/status', authenticate, async (req, res) => {
  try {
    const [procData, taskData, histVars] = await Promise.all([
      flowable('GET', `/history/historic-process-instances/${req.params.processInstanceId}`),
      flowable('GET', `/runtime/tasks?processInstanceId=${req.params.processInstanceId}&size=10`),
      flowable('GET', `/history/historic-variable-instances?processInstanceId=${req.params.processInstanceId}`),
    ]);

    // Build variable map
    const varMap = {};
    (histVars?.data || []).forEach(v => {
      const name = v.variable?.name ?? v.variableName;
      const value = v.variable?.value ?? v.value;
      if (name) varMap[name] = value;
    });

    // Get completed tasks from history
    const histTasks = await flowable('GET',
      `/history/historic-task-instances?processInstanceId=${req.params.processInstanceId}&size=50`);
    const history = (histTasks?.data || [])
      .filter(t => t.endTime)
      .map(t => ({
        taskKey: t.taskDefinitionKey,
        name: t.name,
        completedAt: t.endTime,
        completedBy: t.assignee || null,
        durationMs: t.durationInMillis,
      }));

    const currentTask = (taskData?.data || [])[0];

    res.json({
      data: {
        processInstanceId: req.params.processInstanceId,
        ended: procData?.ended ?? false,
        endTime: procData?.endTime ?? null,
        currentTask: currentTask?.taskDefinitionKey ?? null,
        currentTaskName: currentTask?.name ?? null,
        variables: varMap,
        history,
      }
    });
  } catch (e) {
    console.error('Process status error:', e.message);
    res.status(502).json({ error: 'Flowable unavailable', detail: e.message });
  }
});

setInterval(() => { const n = Date.now(); for (const [id, c] of Object.entries(authChallenges)) if (n > c.expiresAt + 60000) delete authChallenges[id]; }, 60000);

// ── WebSocket ─────────────────────────────────────────────────────────────────
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/events' });
wss.on('connection', ws => {
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
