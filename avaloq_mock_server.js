'use strict';
require('dotenv').config({ path: '/srv/private-banking/.env' });
const express = require('express');
const crypto  = require('crypto');
const app     = express();
app.use(express.json());


// ── URL rewriter: map + to - internally for Express routing ──────────────────
app.use((req, res, next) => {
  console.log('REQUEST:', req.method, req.url, '→', req.path);
  req.url = req.url.replace(/obj-bps%2B/gi, 'obj-bps-').replace(/obj-conts%2B/gi, 'obj-conts-');
  console.log('REWRITTEN:', req.url);
  next();
});

const PORT     = process.env.AVALOQ_MOCK_PORT || 3003;
const VERSION  = '2.0.0';
const API_BASE = '/api1';

// ── Auth middleware ───────────────────────────────────────────────────────────
// Decodes bearer token as base64 JSON: { personId: 'P001' }
// In production: validate JWT against Avaloq JWKS endpoint
function auth(req, res, next) {
  const hdr = req.headers['authorization'] || '';
  if (!hdr.startsWith('Bearer ')) {
    return res.status(401).json({ type: 'UNAUTHORIZED', title: 'Missing bearer token', status: 401 });
  }
  try {
    const decoded = JSON.parse(Buffer.from(hdr.slice(7), 'base64').toString());
    req.avqPersonId = decoded.personId || 'P001';
  } catch {
    req.avqPersonId = 'P001';
  }
  next();
}

// ── Correlation ID middleware ──────────────────────────────────────────────────
app.use((req, res, next) => {
  const corrId = req.headers['x-correlation-id'] || crypto.randomUUID();
  res.set('x-correlation-id', corrId);
  next();
});

// ── Reference data ────────────────────────────────────────────────────────────
const CURRENCY_ASSET = (iso) => ({ extn: { assetIso: [{ val: iso }] } });

// ── Persons (clients only — staff are NOT in Avaloq) ─────────────────────────
const PERSONS = {
  1001: {
    id: 1001,
    bdeRecVersion: 1618390720445001,
    openDate: '2018-03-15',
    birthDate: '1975-06-12',
    gender: { intlId: 'M', id: 1 },
    lang: { intlId: 'EN', id: 1 },
    personNameList: [{
      firstName: 'Philippe',
      lastName:  'Meyer',
      fullName:  'Philippe Meyer',
      fullNameA: true,
      lang: { intlId: 'EN', id: 1 },
      title: { intlId: 'MR', id: 1 },
    }],
    objNameList: [{
      name:     'Philippe Meyer',
      nameAbbr: 'P. Meyer',
      nameLong: 'Philippe Meyer',
      lang: { intlId: 'EN', id: 1 },
    }],
    personDetList: [{
      personType:  { intlId: 'NATURAL', id: 1 },
      legalForm:   { intlId: 'INDIVIDUAL', id: 1 },
      clientStatus:{ intlId: 'ACTIVE', id: 1 },
      startDate:   '2018-03-15',
    }],
    // BP relations — links this person to BP 2001 as OWNER
    bpPersonRelList: [{
      bpPersonRelType: { intlId: 'ACCOUNT_HOLDER', id: 1 },
      authDet: {
        authRole:   { intlId: 'OWNER', id: 1 },
        limit:      null,
        authStatus: { intlId: 'ACTIVE', id: 1 },
      },
      trgObj: { id: 2001 },  // → BP 2001
      validFrom: '2018-03-15',
      validTo:   null,
    }],
  },
  1002: {
    id: 1002,
    bdeRecVersion: 1618390720445002,
    openDate: '2019-01-10',
    birthDate: '1978-09-24',
    gender: { intlId: 'F', id: 2 },
    lang: { intlId: 'EN', id: 1 },
    personNameList: [{
      firstName: 'Sophie',
      lastName:  'Meyer',
      fullName:  'Sophie Meyer',
      fullNameA: true,
      lang: { intlId: 'EN', id: 1 },
      title: { intlId: 'MRS', id: 2 },
    }],
    objNameList: [{
      name:     'Sophie Meyer',
      nameAbbr: 'S. Meyer',
      nameLong: 'Sophie Meyer',
      lang: { intlId: 'EN', id: 1 },
    }],
    personDetList: [{
      personType:  { intlId: 'NATURAL', id: 1 },
      legalForm:   { intlId: 'INDIVIDUAL', id: 1 },
      clientStatus:{ intlId: 'ACTIVE', id: 1 },
      startDate:   '2019-01-10',
    }],
    bpPersonRelList: [{
      bpPersonRelType: { intlId: 'ACCOUNT_HOLDER', id: 1 },
      authDet: {
        authRole:   { intlId: 'CO_SIGNER', id: 2 },
        limit:      10000,
        authStatus: { intlId: 'ACTIVE', id: 1 },
      },
      trgObj: { id: 2001 },  // → BP 2001
      validFrom: '2019-01-10',
      validTo:   null,
    }],
  },
};

// ── Business Partners ─────────────────────────────────────────────────────────
// BP CLT-INFO shape: id, bdeRecVersion, blockText, extn.bpNr, refCurry, regOwner
// BP AVQ_ACC_OWNER_NAME shape: id, bpPersonRelList[].authDet.authRole + trgObj.personNameList
const BUSINESS_PARTNERS = {
  2001: {
    id: 2001,
    bdeRecVersion: 1618390720445100,
    blockText: null,
    extn: { bpNr: [{ val: 'BP-001' }] },
    refCurry: CURRENCY_ASSET('CHF'),
    // regOwner — registered owner (Philippe Meyer)
    regOwner: {
      id: 1001,
      personNameList: [{
        firstName: 'Philippe',
        lastName:  'Meyer',
        fullName:  'Philippe Meyer',
        title: { intlId: 'MR', id: 1 },
      }],
    },
    // bpPersonRelList — persons with access rights on this BP
    // Used by AVQ_ACC_OWNER_NAME shape
    bpPersonRelList: [
      {
        authKey: 1,
        bpPersonRelType: { intlId: 'ACCOUNT_HOLDER', id: 1 },
        authDet: {
          authRole:   { intlId: 'OWNER', id: 1 },
          limit:      null,
          authStatus: { intlId: 'ACTIVE', id: 1 },
          authCrd:    1,
        },
        trgObj: {
          id: 1001,
          objNameList: [{ name: 'Philippe Meyer', nameAbbr: 'P. Meyer', nameLong: 'Philippe Meyer' }],
          personNameList: [{ fullName: 'Philippe Meyer' }],
        },
        validFrom: '2018-03-15',
        validTo:   null,
      },
      {
        authKey: 2,
        bpPersonRelType: { intlId: 'ACCOUNT_HOLDER', id: 1 },
        authDet: {
          authRole:   { intlId: 'CO_SIGNER', id: 2 },
          limit:      10000,
          authStatus: { intlId: 'ACTIVE', id: 1 },
          authCrd:    1,
        },
        trgObj: {
          id: 1002,
          objNameList: [{ name: 'Sophie Meyer', nameAbbr: 'S. Meyer', nameLong: 'Sophie Meyer' }],
          personNameList: [{ fullName: 'Sophie Meyer' }],
        },
        validFrom: '2019-01-10',
        validTo:   null,
      },
    ],
    // Internal: which containers belong to this BP
    _containerIds: [10001, 10002, 10003],
  },
};

// ── Containers (Positions) ────────────────────────────────────────────────────
// Defined inline — same as before, matching GETACCOUNTS spec
const ASSET_META = {
  101: { name:'Apple Inc.',         isin:'US0378331005', ticker:'AAPL',   type:'EQUITY',   ccy:'USD' },
  102: { name:'Microsoft Corp.',    isin:'US5949181045', ticker:'MSFT',   type:'EQUITY',   ccy:'USD' },
  103: { name:'Alphabet Inc.',      isin:'US02079K3059', ticker:'GOOGL',  type:'EQUITY',   ccy:'USD' },
  104: { name:'Cisco Systems',      isin:'US17275R1023', ticker:'CSCO',   type:'EQUITY',   ccy:'USD' },
  105: { name:'Nestlé SA',          isin:'CH0012221716', ticker:'NESN',   type:'EQUITY',   ccy:'CHF' },
  106: { name:'Novartis AG',        isin:'CH0012221716', ticker:'NOVN',   type:'EQUITY',   ccy:'CHF' },
  107: { name:'Roche Holding AG',   isin:'CH0012032048', ticker:'ROG',    type:'EQUITY',   ccy:'CHF' },
  108: { name:'Zurich Insurance',   isin:'CH0011075394', ticker:'ZURN',   type:'EQUITY',   ccy:'CHF' },
  109: { name:'UBS Group AG',       isin:'CH0244767585', ticker:'UBS',    type:'EQUITY',   ccy:'CHF' },
  201: { name:'Swiss Govt Bond 2.5% 2030', isin:'CH0031835561', ticker:'BOND-1', type:'BOND_GOVT', ccy:'CHF', maturity:'2030-03-08', coupon:2.5 },
  202: { name:'EU Corp Bond 3.1% 2028',    isin:'XS1234567890', ticker:'BOND-2', type:'BOND_CORP', ccy:'EUR', maturity:'2028-06-15', coupon:3.1 },
  203: { name:'US Treasury 4.0% 2029',     isin:'US912810TM17', ticker:'BOND-3', type:'BOND_GOVT', ccy:'USD', maturity:'2029-11-15', coupon:4.0 },
};

// ── Builder helpers ───────────────────────────────────────────────────────────
function buildPos(id, subType, assetId, ticker, qty, currValPos, currValRef, histValPos, histValRef) {
  return {
    id, openDate: '2021-01-01',
    objSubType: { id: 1, intlId: subType },
    asset: buildAsset(assetId, ticker),
    qty, currValPos, currValRef, histValPos, histValRef,
    accrPos: 0, accrRef: 0,
    refCurry: CURRENCY_ASSET('CHF'),
    extn: { posSym: [{ val: ticker }], posNr: [{ val: String(id) }] },
  };
}

function buildBondPos(id, assetId, ticker, qty, currValPos, currValRef, histValPos, histValRef, accrPos, accrRef) {
  return {
    id, openDate: '2022-01-01',
    objSubType: { id: 2, intlId: 'BOND' },
    asset: buildAsset(assetId, ticker),
    qty, currValPos, currValRef, histValPos, histValRef,
    accrPos, accrRef,
    refCurry: CURRENCY_ASSET('CHF'),
    extn: { posSym: [{ val: ticker }], posNr: [{ val: String(id) }] },
  };
}

function buildCashPos(id, iso, amount, iban) {
  return {
    id, openDate: '2020-01-01',
    objSubType: { id: 10, intlId: 'CASH' },
    asset: { id: iso === 'CHF' ? 1 : iso === 'USD' ? 2 : 3,
             extn: { assetIso: [{ val: iso }], assType: { class: { ident: 'CASH', name: 'Cash' } } },
             nomCurry: CURRENCY_ASSET(iso) },
    qty: 1, currValPos: amount, currValRef: amount * (iso === 'USD' ? 0.912 : iso === 'EUR' ? 0.987 : 1),
    histValPos: amount, histValRef: amount,
    accrPos: 0, accrRef: 0,
    refCurry: CURRENCY_ASSET('CHF'),
    extn: { posIban: [{ val: iban }], posNr: [{ val: String(id) }] },
  };
}


function buildAsset(id, ticker) {
  const m = ASSET_META[id] || {};
  const asset = {
    id,
    objNameList: [{ lang: { id:1, intlId:'EN' }, name: m.name, nameAbbr: m.ticker, nameLong: m.name }],
    extn: {
      assetIsin: m.isin ? [{ val: m.isin }] : [],
      assetTkn:  [{ val: ticker }],
      assType:   { class: { ident: m.type || 'EQUITY', name: m.type || 'Equity' } },
    },
    nomCurry: CURRENCY_ASSET(m.ccy || 'CHF'),
    mktRelList: [{ curry: CURRENCY_ASSET(m.ccy || 'CHF'), mkt: { id: m.ccy === 'CHF' ? 2 : 1 }, prio: 1 }],
  };
  if (m.maturity) {
    asset.maturityDate = m.maturity;
    asset.compoIntrList = [{ intrCalcMethod: { intlId: 'ACT_365' }, intrRateList: [{ rate: m.coupon }] }];
  }
  return asset;
}

const CONTAINERS = [
  {
    id: 10001,
    extn: { contNr: [{ val: 'P-1001' }] },
    objNameList: [{ lang: { id: 1, intlId: 'EN' }, name: 'Global Balanced', nameAbbr: 'P-1001', nameLong: 'Global Balanced Portfolio' }],
    refCurry: CURRENCY_ASSET('CHF'),
    _bpId: 2001,
    posList: [
      buildPos(100101, 'SECURITY', 101, 'AAPL', 1258, 238421.96, 217400.63, 185000, 168700),
      buildPos(100102, 'SECURITY', 102, 'MSFT',  420, 174384.00, 158978.05, 145000, 132200),
      buildPos(100103, 'SECURITY', 103, 'GOOGL', 890, 158687.00, 144682.38, 128000, 116700),
      buildPos(100104, 'SECURITY', 105, 'NESN', 2000, 189000.00, 189000.00, 176000, 176000),
      buildBondPos(100105, 201, 'BOND-1', 500000, 512500, 512500, 500000, 500000, 6250, 6250),
      buildCashPos(100190, 'CHF', 850000, 'CH12 3456 7891 2345'),
    ],
  },
  {
    id: 10002,
    extn: { contNr: [{ val: 'P-1002' }] },
    objNameList: [{ lang: { id: 1, intlId: 'EN' }, name: 'Swiss Equity Focus', nameAbbr: 'P-1002', nameLong: 'Swiss Equity Focus Portfolio' }],
    refCurry: CURRENCY_ASSET('CHF'),
    _bpId: 2001,
    posList: [
      buildPos(100201, 'SECURITY', 106, 'NOVN', 1500, 147300, 147300, 132000, 132000),
      buildPos(100202, 'SECURITY', 107, 'ROG',   600, 157380, 157380, 145000, 145000),
      buildPos(100203, 'SECURITY', 108, 'ZURN',  280, 125608, 125608, 112000, 112000),
      buildBondPos(100204, 202, 'BOND-2', 300000, 296100, 292451.70, 300000, 296100, 4650, 4594.05),
      buildCashPos(100290, 'CHF', 480000, 'CH98 7654 3219 8765'),
    ],
  },
  {
    id: 10003,
    extn: { contNr: [{ val: 'P-1003' }] },
    objNameList: [{ lang: { id: 1, intlId: 'EN' }, name: 'Fixed Income & Cash', nameAbbr: 'P-1003', nameLong: 'Fixed Income and Cash Reserve Portfolio' }],
    refCurry: CURRENCY_ASSET('CHF'),
    _bpId: 2001,
    posList: [
      buildPos(100301, 'SECURITY', 104, 'CSCO', 3200, 167680, 152883, 155000, 141300),
      buildPos(100302, 'SECURITY', 109, 'UBS',  4500, 130050, 130050, 118000, 118000),
      buildBondPos(100303, 203, 'BOND-3', 400000, 389200, 354830.40, 400000, 364800, 8000, 7296),
      buildCashPos(100390, 'CHF', 720000, 'CH56 7890 1234 5678'),
      buildCashPos(100391, 'USD', 450000, 'CH11 2345 6789 0123'),
    ],
  },
];

// ── Access control ────────────────────────────────────────────────────────────
function getAccessibleBpIds(personId) {
  if (personId === 'SYSTEM' || personId === 'system') return Object.values(BUSINESS_PARTNERS).map(bp => bp.id);
  const bps = Object.values(BUSINESS_PARTNERS);
  bps.forEach(bp => bp.bpPersonRelList.forEach(r => {
  }));
  return bps.filter(bp => bp.bpPersonRelList.some(r => r.trgObj?.id === personId)).map(bp => bp.id);
}

function getAccessibleContainerIds(personId) {
  // SYSTEM token gets full access (BFF server-to-server calls)
  if (personId === 'SYSTEM' || personId === 'system') {
    return CONTAINERS.map(c => c.id);
  }
  const bpIds = getAccessibleBpIds(personId);
  const ids = [];
  for (const bpId of bpIds) {
    ids.push(...(BUSINESS_PARTNERS[bpId]?._containerIds || []));
  }
  return ids;
}

// ── Pagination ────────────────────────────────────────────────────────────────
function paginate(arr, limit = 5, offset = 0) {
  return { items: arr.slice(offset, offset + limit), hasNext: offset + limit < arr.length };
}

// ── Filter (basic Avaloq filter expression support) ───────────────────────────
function applyFilter(items, expr) {
  if (!expr) return items;
  // extn.contNr.val=='P-1001'
  let m = expr.match(/extn\.contNr\.val\s*==\s*'?([^'&\s]+)'?/);
  if (m) return items.filter(c => c.extn?.contNr?.some(n => n.val === m[1]));
  // extn.bpNr.val=='BP-001'
  m = expr.match(/extn\.bpNr\.val\s*==\s*'?([^'&\s]+)'?/);
  if (m) return items.filter(b => b.extn?.bpNr?.some(n => n.val === m[1]));
  // extn.personNr.val=='...'
  m = expr.match(/extn\.personNr\.val\s*==\s*'?([^'&\s]+)'?/);
  if (m) return items.filter(p => p.extn?.personNr?.some(n => n.val === m[1]));
  return items;
}

// ── Sanitize (remove internal fields) ────────────────────────────────────────
function sanitize(obj) {
  const { _bpId, _containerIds, ...rest } = obj;
  return rest;
}

// ── BP shape helpers ──────────────────────────────────────────────────────────
function bpForCltInfo(bp) {
  const { _containerIds, bpPersonRelList, ...rest } = bp;
  return rest;
}

function bpForAccOwnerName(bp) {
  return { id: bp.id, bpPersonRelList: bp.bpPersonRelList };
}

// ═══════════════════════════════════════════════════════════════════════════════
// ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════════════

// Health
app.get('/health', (_, res) => res.json({
  status: 'ok', version: VERSION, service: 'avaloq-mock',
  persons: Object.keys(PERSONS).length,
  businessPartners: Object.keys(BUSINESS_PARTNERS).length,
  containers: CONTAINERS.length,
  timestamp: new Date().toISOString(),
}));

// ── GET /obj-conts+getaccounts ────────────────────────────────────────────────
app.get('/api1/obj-conts-getaccounts', auth, (req, res) => {
  const { filter, limit = 5, offset = 0 } = req.query;
  const accessIds = getAccessibleContainerIds(req.avqPersonId);
  let results = CONTAINERS.filter(c => accessIds.includes(c.id));
  results = applyFilter(results, filter);
  const { items, hasNext } = paginate(results, +limit, +offset);
  res.set('Content-Language', 'en').set('X-Has-Next-Page', String(hasNext));
  res.json(items.map(sanitize));
});

// ── GET /obj-conts+getaccounts/:id ───────────────────────────────────────────
app.get('/api1/obj-conts-getaccounts/:id', auth, (req, res) => {
  const id   = parseInt(req.params.id || req.params[0]);
  const cont = CONTAINERS.find(c => c.id === id);
  const accessIds = getAccessibleContainerIds(req.avqPersonId);
  if (!cont || !accessIds.includes(id)) {
    return res.status(404).json({ type: 'NOT_FOUND', title: 'Container not found', status: 404 });
  }
  const etag = `"${id}-v1"`;
  if (req.headers['if-none-match'] === etag) return res.status(304).end();
  res.set('Content-Language', 'en').set('ETag', etag);
  res.json(sanitize(cont));
});

// ── GET /obj-bps+avq_acc_owner_name ──────────────────────────────────────────
// Returns BP with bpPersonRelList (who has access + their authRole)
app.get('/api1/obj-bps-avq_acc_owner_name', auth, (req, res) => {
  const { filter, limit = 5, offset = 0 } = req.query;
  const bpIds = getAccessibleBpIds(req.avqPersonId);
  let results = Object.values(BUSINESS_PARTNERS).filter(bp => bpIds.includes(bp.id));
  results = applyFilter(results, filter);
  const { items, hasNext } = paginate(results, +limit, +offset);
  res.set('Content-Language', 'en').set('X-Has-Next-Page', String(hasNext));
  res.json(items.map(bpForAccOwnerName));
});

// ── GET /obj-bps+avq_acc_owner_name/:id ──────────────────────────────────────
app.get('/api1/obj-bps-avq_acc_owner_name/:id', auth, (req, res) => {
  const id = parseInt(req.params.id || req.params[0]);
  const bp = BUSINESS_PARTNERS[id];
  const bpIds = getAccessibleBpIds(req.avqPersonId);
  if (!bp || !bpIds.includes(id)) {
    return res.status(404).json({ type: 'NOT_FOUND', title: 'Business partner not found', status: 404 });
  }
  const etag = `"bp-${id}-owner-v1"`;
  if (req.headers['if-none-match'] === etag) return res.status(304).end();
  res.set('Content-Language', 'en').set('ETag', etag);
  res.json(bpForAccOwnerName(bp));
});

// ── GET /obj-bps+clt-info ────────────────────────────────────────────────────
// Returns BP with client info: bpNr, refCurry, regOwner (registered owner)
app.get('/api1/obj-bps-clt-info', auth, (req, res) => {
  const { filter, limit = 5, offset = 0 } = req.query;
  const bpIds = getAccessibleBpIds(req.avqPersonId);
  let results = Object.values(BUSINESS_PARTNERS).filter(bp => bpIds.includes(bp.id));
  results = applyFilter(results, filter);
  const { items, hasNext } = paginate(results, +limit, +offset);
  res.set('Content-Language', 'en').set('X-Has-Next-Page', String(hasNext));
  res.json(items.map(bpForCltInfo));
});

// ── GET /obj-bps+clt-info/:id ────────────────────────────────────────────────
app.get('/api1/obj-bps-clt-info/:id', auth, (req, res) => {
  const id = parseInt(req.params.id || req.params[0]);
  const bp = BUSINESS_PARTNERS[id];
  const bpIds = getAccessibleBpIds(req.avqPersonId);
  if (!bp || !bpIds.includes(id)) {
    return res.status(404).json({ type: 'NOT_FOUND', title: 'Business partner not found', status: 404 });
  }
  const etag = `"bp-${id}-clt-v1"`;
  if (req.headers['if-none-match'] === etag) return res.status(304).end();
  res.set('Content-Language', 'en').set('ETag', etag);
  res.json(bpForCltInfo(bp));
});

// ── GET /obj-persons ──────────────────────────────────────────────────────────
// Returns only persons accessible by the requesting person
// (a person can always see themselves; persons on same BP are also visible)
app.get(`${API_BASE}/obj-persons`, auth, (req, res) => {
  const { filter, limit = 5, offset = 0 } = req.query;
  const callerBpIds = getAccessibleBpIds(req.avqPersonId);
  // SYSTEM sees all persons
  if (req.avqPersonId === 'SYSTEM' || req.avqPersonId === 'system') {
    const { items, hasNext } = paginate(Object.values(PERSONS), +limit, +offset);
    return res.set('Content-Language', 'en').set('X-Has-Next-Page', String(hasNext)).json(items);
  }
  // Get all person IDs on the same BPs
  const visiblePersonIds = new Set([req.avqPersonId]);
  for (const bpId of callerBpIds) {
    const bp = BUSINESS_PARTNERS[bpId];
    if (bp) bp.bpPersonRelList.forEach(r => visiblePersonIds.add(r.trgObj?.id));
  }
  let results = Object.values(PERSONS).filter(p => visiblePersonIds.has(p.id));
  results = applyFilter(results, filter);
  const { items, hasNext } = paginate(results, +limit, +offset);
  res.set('Content-Language', 'en').set('X-Has-Next-Page', String(hasNext));
  res.json(items);
});

// ── GET /obj-persons/:id ──────────────────────────────────────────────────────
app.get(`${API_BASE}/obj-persons/:id`, auth, (req, res) => {
  const id     = parseInt(req.params.id);
  const person = PERSONS[id];
  if (!person) {
    return res.status(404).json({ type: 'NOT_FOUND', title: 'Person not found', status: 404 });
  }
  // Access check: can only see yourself or persons on same BP
  const callerBpIds = getAccessibleBpIds(req.avqPersonId);
  const visibleIds  = new Set([req.avqPersonId]);
  for (const bpId of callerBpIds) {
    const bp = BUSINESS_PARTNERS[bpId];
    if (bp) bp.bpPersonRelList.forEach(r => visibleIds.add(r.trgObj?.id));
  }
  if (!visibleIds.has(id)) {
    return res.status(404).json({ type: 'NOT_FOUND', title: 'Person not found', status: 404 });
  }
  const etag = `"person-${id}-v${person.bdeRecVersion}"`;
  if (req.headers['if-none-match'] === etag) return res.status(304).end();
  res.set('Content-Language', 'en').set('ETag', etag);
  res.json(person);
});

// ── POST /obj-persons ─────────────────────────────────────────────────────────
app.post(`${API_BASE}/obj-persons`, auth, (req, res) => {
  const newId  = Math.max(...Object.keys(PERSONS).map(Number)) + 1;
  const person = { id: newId, bdeRecVersion: Date.now(), ...req.body };
  PERSONS[newId] = person;
  const location = `${API_BASE}/obj-persons/${newId}`;
  res.status(201).set('Location', location).set('ETag', `"person-${newId}-v1"`);
  res.json({ id: newId, bdeRecVersion: person.bdeRecVersion });
});

// ── PATCH /obj-persons/:id ────────────────────────────────────────────────────
app.patch(`${API_BASE}/obj-persons/:id`, auth, (req, res) => {
  const id = parseInt(req.params.id);
  if (!PERSONS[id]) {
    return res.status(404).json({ type: 'NOT_FOUND', title: 'Person not found', status: 404 });
  }
  // If-Match ETag check
  const ifMatch = req.headers['if-match'];
  if (ifMatch && ifMatch !== `"person-${id}-v${PERSONS[id].bdeRecVersion}"`) {
    return res.status(412).json({ type: 'PRECONDITION_FAILED', title: 'ETag mismatch', status: 412 });
  }
  PERSONS[id] = { ...PERSONS[id], ...req.body, id, bdeRecVersion: Date.now() };
  res.set('ETag', `"person-${id}-v${PERSONS[id].bdeRecVersion}"`);
  res.json({ id, bdeRecVersion: PERSONS[id].bdeRecVersion });
});

// ── DELETE /obj-persons/:id ───────────────────────────────────────────────────
app.delete(`${API_BASE}/obj-persons/:id`, auth, (req, res) => {
  const id = parseInt(req.params.id);
  if (!PERSONS[id]) {
    return res.status(404).json({ type: 'NOT_FOUND', title: 'Person not found', status: 404 });
  }
  delete PERSONS[id];
  res.status(200).json({});
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🏦 Avaloq Mock API v${VERSION}`);
  console.log(`   REST → http://localhost:${PORT}`);
  console.log(`   Persons: GET/POST/PATCH/DELETE ${API_BASE}/obj-persons`);
  console.log(`   BP (CLT-INFO): GET ${API_BASE}/obj-bps%2Bclt-info`);
  console.log(`   BP (ACC-OWNER): GET ${API_BASE}/obj-bps%2Bavq_acc_owner_name`);
  console.log(`   Containers: GET ${API_BASE}/obj-conts%2Bgetaccounts`);
  console.log(`   ⚠️  Staff are NOT in Avaloq — managed at BFF level`);
});
