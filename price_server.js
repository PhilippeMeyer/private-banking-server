'use strict';
require('dotenv').config({ path: '/srv/private-banking/.env' });
const express = require('express');
const app = express();
app.use(express.json());

const PORT    = 3002;
const VERSION = '2.0.0';

// ── Instrument definitions ────────────────────────────────────────────────────
// yahooSymbol: symbol used to fetch from Yahoo Finance
// For crypto, we use CoinGecko IDs via coinGeckoId field
const INSTRUMENTS = {
  // ── US Equities ──────────────────────────────────────────────────────────
  'AAPL':  { name:'Apple Inc.',          currency:'USD', sector:'Technology',    yahooSymbol:'AAPL',    vol:0.018, basePrice:189.50 },
  'MSFT':  { name:'Microsoft Corp.',     currency:'USD', sector:'Technology',    yahooSymbol:'MSFT',    vol:0.016, basePrice:415.20 },
  'GOOGL': { name:'Alphabet Inc.',       currency:'USD', sector:'Technology',    yahooSymbol:'GOOGL',   vol:0.019, basePrice:178.30 },
  'AMZN':  { name:'Amazon.com Inc.',     currency:'USD', sector:'Technology',    yahooSymbol:'AMZN',    vol:0.020, basePrice:184.70 },
  'NVDA':  { name:'NVIDIA Corp.',        currency:'USD', sector:'Technology',    yahooSymbol:'NVDA',    vol:0.030, basePrice:875.40 },
  'META':  { name:'Meta Platforms',      currency:'USD', sector:'Technology',    yahooSymbol:'META',    vol:0.022, basePrice:487.60 },
  'TSLA':  { name:'Tesla Inc.',          currency:'USD', sector:'Automotive',    yahooSymbol:'TSLA',    vol:0.035, basePrice:245.80 },
  'CSCO':  { name:'Cisco Systems',       currency:'USD', sector:'Technology',    yahooSymbol:'CSCO',    vol:0.012, basePrice:52.40  },
  'JPM':   { name:'JPMorgan Chase',      currency:'USD', sector:'Financials',    yahooSymbol:'JPM',     vol:0.015, basePrice:198.30 },
  'BAC':   { name:'Bank of America',     currency:'USD', sector:'Financials',    yahooSymbol:'BAC',     vol:0.016, basePrice:38.90  },
  // ── Swiss Equities ───────────────────────────────────────────────────────
  'NESN':  { name:'Nestlé SA',           currency:'CHF', sector:'Consumer',      yahooSymbol:'NESN.SW', vol:0.010, basePrice:94.50  },
  'NOVN':  { name:'Novartis AG',         currency:'CHF', sector:'Healthcare',    yahooSymbol:'NOVN.SW', vol:0.012, basePrice:98.20  },
  'ROG':   { name:'Roche Holding AG',    currency:'CHF', sector:'Healthcare',    yahooSymbol:'ROG.SW',  vol:0.013, basePrice:262.30 },
  'ZURN':  { name:'Zurich Insurance',    currency:'CHF', sector:'Financials',    yahooSymbol:'ZURN.SW', vol:0.011, basePrice:448.60 },
  'UBS':   { name:'UBS Group AG',        currency:'CHF', sector:'Financials',    yahooSymbol:'UBS.SW',  vol:0.014, basePrice:28.90  },
  'ABBN':  { name:'ABB Ltd.',            currency:'CHF', sector:'Industrials',   yahooSymbol:'ABBN.SW', vol:0.013, basePrice:47.20  },
  'GIVN':  { name:'Givaudan SA',         currency:'CHF', sector:'Consumer',      yahooSymbol:'GIVN.SW', vol:0.012, basePrice:3980.0 },
  'LONN':  { name:'Lonza Group AG',      currency:'CHF', sector:'Healthcare',    yahooSymbol:'LONN.SW', vol:0.016, basePrice:412.50 },
  'CFR':   { name:'Richemont SA',        currency:'CHF', sector:'Luxury',        yahooSymbol:'CFR.SW',  vol:0.015, basePrice:138.40 },
  'SIKA':  { name:'Sika AG',             currency:'CHF', sector:'Materials',     yahooSymbol:'SIKA.SW', vol:0.014, basePrice:248.70 },
  // ── European Equities ────────────────────────────────────────────────────
  'ASML':  { name:'ASML Holding',        currency:'EUR', sector:'Technology',    yahooSymbol:'ASML',    vol:0.022, basePrice:742.50 },
  'SAP':   { name:'SAP SE',              currency:'EUR', sector:'Technology',    yahooSymbol:'SAP',     vol:0.016, basePrice:198.60 },
  'LVMH':  { name:'LVMH SE',             currency:'EUR', sector:'Luxury',        yahooSymbol:'MC.PA',   vol:0.017, basePrice:742.00 },
  'TTE':   { name:'TotalEnergies SE',    currency:'EUR', sector:'Energy',        yahooSymbol:'TTE.PA',  vol:0.014, basePrice:58.40  },
  'SIE':   { name:'Siemens AG',          currency:'EUR', sector:'Industrials',   yahooSymbol:'SIE.DE',  vol:0.015, basePrice:185.20 },
  // ── ETFs ─────────────────────────────────────────────────────────────────
  'SPY':   { name:'SPDR S&P 500 ETF',    currency:'USD', sector:'ETF',           yahooSymbol:'SPY',     vol:0.012, basePrice:524.80 },
  'QQQ':   { name:'Invesco QQQ ETF',     currency:'USD', sector:'ETF',           yahooSymbol:'QQQ',     vol:0.016, basePrice:446.20 },
  'EWL':   { name:'iShares MSCI Swiss',  currency:'USD', sector:'ETF',           yahooSymbol:'EWL',     vol:0.010, basePrice:49.80  },
  'VTI':   { name:'Vanguard Total US',   currency:'USD', sector:'ETF',           yahooSymbol:'VTI',     vol:0.012, basePrice:248.60 },
  'IEMG':  { name:'iShares Emerging Mkt',currency:'USD', sector:'ETF',           yahooSymbol:'IEMG',    vol:0.015, basePrice:52.30  },
  'GLD':   { name:'SPDR Gold Shares',    currency:'USD', sector:'ETF',           yahooSymbol:'GLD',     vol:0.009, basePrice:214.70 },
  'TLT':   { name:'iShares 20Y Treasury',currency:'USD', sector:'ETF',           yahooSymbol:'TLT',     vol:0.008, basePrice:96.40  },
  // ── Bond ETFs ────────────────────────────────────────────────────────────
  'BOND-1':{ name:'Swiss Govt Bond',     currency:'CHF', sector:'Fixed Income',  yahooSymbol:null,      vol:0.002, basePrice:102.50 },
  'BOND-2':{ name:'EU Corp Bond ETF',    currency:'EUR', sector:'Fixed Income',  yahooSymbol:'LQD',     vol:0.004, basePrice:98.70  },
  'BOND-3':{ name:'US Treasury ETF',     currency:'USD', sector:'Fixed Income',  yahooSymbol:'IEF',     vol:0.004, basePrice:97.30  },
  'SHY':   { name:'iShares 1-3Y Treas.', currency:'USD', sector:'Fixed Income',  yahooSymbol:'SHY',     vol:0.002, basePrice:82.50  },
  // ── FX (price = units of CHF per 1 unit of foreign currency) ─────────────
  'USDCHF':{ name:'USD/CHF',             currency:'CHF', sector:'FX',            yahooSymbol:'USDCHF=X',vol:0.003, basePrice:0.912  },
  'EURCHF':{ name:'EUR/CHF',             currency:'CHF', sector:'FX',            yahooSymbol:'EURCHF=X',vol:0.003, basePrice:0.987  },
  'GBPCHF':{ name:'GBP/CHF',             currency:'CHF', sector:'FX',            yahooSymbol:'GBPCHF=X',vol:0.004, basePrice:1.156  },
  'JPYCHF':{ name:'JPY/CHF',             currency:'CHF', sector:'FX',            yahooSymbol:'JPYCHF=X',vol:0.004, basePrice:0.0063 },
  // ── Crypto (via CoinGecko) ────────────────────────────────────────────────
  'BTC':   { name:'Bitcoin',             currency:'USD', sector:'Crypto',        yahooSymbol:null,      coinGeckoId:'bitcoin',      vol:0.040, basePrice:67500 },
  'ETH':   { name:'Ethereum',            currency:'USD', sector:'Crypto',        yahooSymbol:null,      coinGeckoId:'ethereum',     vol:0.045, basePrice:3520  },
  'SOL':   { name:'Solana',              currency:'USD', sector:'Crypto',        yahooSymbol:null,      coinGeckoId:'solana',       vol:0.055, basePrice:172   },
  'ADA':   { name:'Cardano',             currency:'USD', sector:'Crypto',        yahooSymbol:null,      coinGeckoId:'cardano',      vol:0.055, basePrice:0.452 },
  'AVAX':  { name:'Avalanche',           currency:'USD', sector:'Crypto',        yahooSymbol:null,      coinGeckoId:'avalanche-2',  vol:0.058, basePrice:38.40 },
};

// ── Indices ───────────────────────────────────────────────────────────────────
const INDICES = {
  'S&P 500':    { yahooSymbol: '^GSPC',     value: 5272.67, vol: 0.010 },
  'SMI':        { yahooSymbol: '^SSMI',     value: 11796.64,vol: 0.008 },
  'Euro Stoxx': { yahooSymbol: '^STOXX50E', value: 4984.92, vol: 0.010 },
  'FTSE 100':   { yahooSymbol: '^FTSE',     value: 8205.50, vol: 0.009 },
  'Nikkei 225': { yahooSymbol: '^N225',     value: 38714.20,vol: 0.012 },
  'Nasdaq':     { yahooSymbol: '^IXIC',     value: 16742.39,vol: 0.014 },
};

// ── FX rates (CHF base) ───────────────────────────────────────────────────────
const fx = { CHF: 1.0, USD: 0.912, EUR: 0.987, GBP: 0.828, JPY: 0.0063 };

// ── Live prices ───────────────────────────────────────────────────────────────
const prices = {};
for (const [id, inst] of Object.entries(INSTRUMENTS)) {
  prices[id] = inst.basePrice;
}

// ── GBM simulation ────────────────────────────────────────────────────────────
function randn() {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

function gbmTick(price, vol, drift = 0) {
  const dt  = 3 / (252 * 6.5 * 3600); // 3s as fraction of trading year
  const pct = Math.exp((drift - 0.5 * vol * vol) * dt + vol * Math.sqrt(dt) * randn()) - 1;
  return { newPrice: +(price * (1 + pct)).toFixed(6), pct: +(pct * 100).toFixed(4) };
}

// Per-instrument real-price anchoring
// When we get a real price, we compute the drift implied by (realPrice / lastPrice - 1)
// and use that to seed the GBM for the next 5 minutes
const drifts = {};
for (const id of Object.keys(INSTRUMENTS)) drifts[id] = 0;

// ── Yahoo Finance fetcher ─────────────────────────────────────────────────────
// ── Twelve Data fetcher ──────────────────────────────────────────────────────
// Free tier: 800 req/day, 8 req/min — we fetch every 5min so ~288/day
// No API key required for basic price endpoint
async function fetchTwelveData(symbolMap) {
  if (!Object.keys(symbolMap).length) return {};
  const result = {};
  // Single request for all symbols — 1 API credit per call
  const allSymbols = Object.keys(symbolMap).join(',');
  const url = `https://api.twelvedata.com/price?symbol=${encodeURIComponent(allSymbols)}&apikey=${process.env.TWELVE_DATA_KEY||''}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) { console.error(`TwelveData HTTP ${res.status}`); return result; }
    const data = await res.json();
    if (data.price) {
      // Single symbol response
      const firstId = Object.values(symbolMap)[0];
      const price = parseFloat(data.price);
      if (!isNaN(price)) result[firstId] = price;
    } else {
      // Multi-symbol response
      for (const [sym, id] of Object.entries(symbolMap)) {
        const price = parseFloat(data[sym]?.price);
        if (!isNaN(price)) result[id] = price;
      }
    }
  } catch (e) {
    console.error('TwelveData fetch error:', e.message);
  }
  return result;
}

// Kept for compatibility — maps Yahoo symbols to TwelveData symbols
// TwelveData uses same symbols for US stocks, and e.g. NESN:SW for Swiss
function toTwelveDataSymbol(yahooSymbol) {
  if (!yahooSymbol) return null;
  // Yahoo: NESN.SW → TwelveData: NESN:SW
  // Yahoo: ^GSPC → TwelveData: SPX (index)
  // Yahoo: USDCHF=X → TwelveData: USD/CHF (forex)
  return yahooSymbol
    .replace(/\.SW$/, ':SW')
    .replace(/\.PA$/, ':PA')
    .replace(/\.DE$/, ':XETRA')
    .replace(/^\^GSPC$/, 'SPX')
    .replace(/^\^SSMI$/, 'SMI')
    .replace(/^\^STOXX50E$/, 'SX5E')
    .replace(/^\^FTSE$/, 'UK100')
    .replace(/^\^N225$/, 'NI225')
    .replace(/^\^IXIC$/, 'NDX')
    .replace(/^(\w+)CHF=X$/, '$1/CHF')
    .replace(/^USDCHF=X$/, 'USD/CHF')
    .replace(/^EURCHF=X$/, 'EUR/CHF')
    .replace(/^GBPCHF=X$/, 'GBP/CHF')
    .replace(/^JPYCHF=X$/, 'JPY/CHF');
}

// Legacy name kept so fetchRealPrices still works
async function fetchYahoo(symbolsMap) {
  // symbolsMap is a { yahooSymbol: id } object from fetchRealPrices
  // Convert to TwelveData symbols
  const tdMap = {};
  for (const [yahooSym, id] of Object.entries(symbolsMap)) {
    const tdSym = toTwelveDataSymbol(yahooSym);
    if (tdSym) tdMap[tdSym] = id;
  }
  return await fetchTwelveData(tdMap);
}

// ── CoinGecko fetcher ─────────────────────────────────────────────────────────
async function fetchCoinGecko(coinIds) {
  if (!coinIds.length) return {};
  const ids = coinIds.join(',');
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`CoinGecko HTTP ${res.status}`);
    const data = await res.json();
    const result = {};
    for (const [id, val] of Object.entries(data)) result[id] = val.usd;
    return result;
  } catch (e) {
    console.error('CoinGecko fetch error:', e.message);
    return {};
  }
}

// ── Real price fetch (every 5 minutes) ───────────────────────────────────────
async function fetchRealPrices() {
  console.log('Fetching real prices...');

  // Build Yahoo symbols list
  const yahooMap = {}; // yahooSymbol → instrumentId
  for (const [id, inst] of Object.entries(INSTRUMENTS)) {
    if (inst.yahooSymbol) yahooMap[inst.yahooSymbol] = id;
  }
  // Add indices
  for (const [name, idx] of Object.entries(INDICES)) {
    yahooMap[idx.yahooSymbol] = `__index__${name}`;
  }

  const yahooResult  = await fetchYahoo(yahooMap);

  let updated = 0;
  for (const [yahooSym, price] of Object.entries(yahooResult)) {
    const id = yahooMap[yahooSym];
    if (!id) continue;
    if (id.startsWith('__index__')) {
      const name = id.replace('__index__', '');
      if (INDICES[name]) {
        INDICES[name].value = price;
        updated++;
      }
    } else {
      const prevPrice = prices[id];
      prices[id] = price;
      // Compute implied drift for next GBM ticks
      if (prevPrice > 0) {
        const impliedReturn = (price / prevPrice - 1);
        drifts[id] = impliedReturn / (5 * 60 / 3); // spread over 5min / 3s ticks
      }
      updated++;
    }
  }

  // FX from Yahoo (USDCHF=X etc. give USD per CHF, we need CHF per USD)
  for (const [id, inst] of Object.entries(INSTRUMENTS)) {
    if (inst.sector === 'FX' && prices[id]) {
      if (id === 'USDCHF') fx['USD'] = +(1 / prices[id]).toFixed(6);
      if (id === 'EURCHF') fx['EUR'] = +(1 / prices[id]).toFixed(6);
      if (id === 'GBPCHF') fx['GBP'] = +(1 / prices[id]).toFixed(6);
      if (id === 'JPYCHF') fx['JPY'] = +(1 / prices[id]).toFixed(6);
    }
  }

  // Crypto via CoinGecko
  const cryptoMap = {}; // coinGeckoId → instrumentId
  for (const [id, inst] of Object.entries(INSTRUMENTS)) {
    if (inst.coinGeckoId) cryptoMap[inst.coinGeckoId] = id;
  }
  const cryptoResult = await fetchCoinGecko(Object.keys(cryptoMap));
  for (const [geckoId, price] of Object.entries(cryptoResult)) {
    const id = cryptoMap[geckoId];
    if (!id) continue;
    const prevPrice = prices[id];
    prices[id] = price;
    if (prevPrice > 0) {
      const impliedReturn = (price / prevPrice - 1);
      drifts[id] = impliedReturn / (5 * 60 / 3);
    }
    updated++;
  }

  console.log(`Real prices updated: ${updated} instruments`);
}

// ── GBM tick (every 3 seconds) ────────────────────────────────────────────────
let lastTickData = null;

function tick() {
  const changes = {};
  for (const [id, inst] of Object.entries(INSTRUMENTS)) {
    const { newPrice, pct } = gbmTick(prices[id], inst.vol, drifts[id] ?? 0);
    const prev = prices[id];
    prices[id] = newPrice;
    changes[id] = { price: newPrice, prevPrice: prev, changePct: pct };
  }
  // Micro-move FX
  for (const ccy of ['USD', 'EUR', 'GBP', 'JPY']) {
    const fxPct = (Math.random() - 0.5) * 0.0002;
    fx[ccy] = +(fx[ccy] * (1 + fxPct)).toFixed(6);
  }
  lastTickData = { changes, fx, indices: getIndices(), timestamp: new Date().toISOString() };
}

function getIndices() {
  const result = {};
  for (const [name, idx] of Object.entries(INDICES)) {
    const { newPrice } = gbmTick(idx.value, idx.vol);
    idx.value = newPrice;
    result[name] = { value: idx.value, change: +((Math.random() - 0.48) * 0.5).toFixed(2) };
  }
  return result;
}

// ── Timers ────────────────────────────────────────────────────────────────────
// Fetch real prices every 2 hours (no immediate startup fetch)
setInterval(fetchRealPrices, 2 * 60 * 60 * 1000);

// GBM tick every 3 seconds
tick();
setInterval(tick, 3000);

// ── REST endpoints ────────────────────────────────────────────────────────────
app.get('/health', (_, res) => res.json({
  status: 'ok', version: VERSION, service: 'price-server',
  instruments: Object.keys(INSTRUMENTS).length,
  lastRealFetch: lastTickData?.timestamp,
  timestamp: new Date().toISOString(),
}));

app.get('/prices', (_, res) => {
  const data = {};
  for (const [id, price] of Object.entries(prices)) {
    const inst = INSTRUMENTS[id];
    data[id] = {
      ...inst, id, price,
      priceChf: +(price * (fx[inst.currency] ?? 1)).toFixed(4),
    };
  }
  res.json({ data, fx, marketOverview: lastTickData?.indices ?? {}, timestamp: new Date().toISOString() });
});

app.get('/prices/:symbol', (req, res) => {
  const id = req.params.symbol.toUpperCase();
  if (!prices[id]) return res.status(404).json({ error: 'Symbol not found' });
  const inst = INSTRUMENTS[id];
  res.json({ data: { ...inst, id, price: prices[id],
    priceChf: +(prices[id] * (fx[inst.currency] ?? 1)).toFixed(4) },
    fx, timestamp: new Date().toISOString() });
});

app.get('/fx', (_, res) => res.json({ data: fx, timestamp: new Date().toISOString() }));

app.get('/market-overview', (_, res) => res.json({
  data: lastTickData?.indices ?? {}, timestamp: new Date().toISOString() }));

app.get('/instruments', (_, res) => res.json({
  data: INSTRUMENTS, timestamp: new Date().toISOString() }));

app.get('/tick', (_, res) => res.json({
  data: lastTickData, timestamp: new Date().toISOString() }));

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`💹 Price Server v${VERSION}`);
  console.log(`   REST → http://localhost:${PORT}`);
  console.log(`   Instruments: ${Object.keys(INSTRUMENTS).length} (${Object.values(INSTRUMENTS).filter(i=>i.yahooSymbol).length} Yahoo + ${Object.values(INSTRUMENTS).filter(i=>i.coinGeckoId).length} CoinGecko + ${Object.values(INSTRUMENTS).filter(i=>!i.yahooSymbol&&!i.coinGeckoId).length} simulated)`);
  console.log(`   Real price fetch: every 2 hours (~468 credits/day)`);
  console.log(`   GBM simulation: every 3s between fetches`);
});
