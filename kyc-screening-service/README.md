# KYC Screening Service

Node/TypeScript microservice that screens subjects against sanctions, PEP,
adverse-media, and custom watchlists, scores overall risk, and keeps an
immutable audit trail.

## Quick start

```bash
npm install
cp .env.example .env      # fill in real source URLs / vendor API keys
npm run migrate           # creates data/kyc.db and applies schema.sql
npm run import:now        # runs every configured import once, immediately
npm run dev                # starts the API + cron scheduler
```

## What's implemented

- **Ingestion** (`src/ingestion/`): one module per source (OFAC SDN +
  Consolidated, UN, EU, UK, Japan MOF, OpenSanctions aggregator, PEP/adverse-media
  vendor feed, custom CSV/JSON). Each fetches, parses, and hands raw records
  to a mapper.
  - **OFAC, UN, EU, UK**: schemas verified directly against the live feeds.
  - **Japan MOF**: publishes XLSX only, in Japanese — the column mapping in
    `.env` (`JP_MOF_COLUMN_*`) is a placeholder, NOT verified against the
    live file. The importer logs the actual column headers it finds on
    every run; update the mapping to match before relying on this source.
  - **OpenSanctions**: aggregates ~100+ jurisdictions (useful for Singapore,
    Hong Kong, and others whose own data isn't a clean feed). Two importers:
    - `ingestion/openSanctions.ts` — simple `targets.simple.csv` import of
      any single dataset (e.g. one country's sanctions list).
    - `ingestion/openSanctionsPep.ts` — **PEP-focused**, streams the full
      `default` collection's `entities.ftm.json` (FollowTheMoney format,
      one JSON object per line) and keeps only entities tagged
      `role.pep`/`role.rca`. This follows OpenSanctions' own documented
      recommendation — they explicitly discourage using the standalone
      `peps` collection, since it drops enrichment data (relative/associate
      links, non-Latin aliases, government-branch annotations). The file
      can be large, so this streams line-by-line rather than buffering the
      whole response. Reads from a local file (`OPENSANCTIONS_FTM_FILE_PATH`,
      no network call at all) if set, otherwise fetches `OPENSANCTIONS_FTM_URL`.
    - **LICENSING** applies to both: OpenSanctions' bulk/API data is free
      for non-commercial use under CC BY-NC 4.0. Whether a given use
      qualifies as non-commercial is a judgment call for you (ideally with
      legal/compliance input) — this code doesn't determine that for you.
      Both importers refuse to run unless `OPENSANCTIONS_LICENSE_CONFIRMED=true`
      is explicitly set, as a deliberate checkpoint rather than a silent default.
- **Normalization** (`src/normalize/`): mappers translate each source's raw
  schema into one `CanonicalEntity` shape. Adding a new source means writing
  one mapper — the matching engine never needs to know source-specific
  formats.
- **Scheduler** (`src/ingestion/scheduler.ts`): `node-cron` jobs, one schedule
  per source (configurable in `.env`), since OFAC/UN/EU update daily but a
  licensed PEP/adverse-media feed might update on a different cadence.
- **Matching** (`src/matching/`): fuzzy name matching (Jaro-Winkler +
  Levenshtein + token overlap), exact DOB/ID boosts, and a risk scorer that
  treats a strong sanctions hit as an automatic "high" regardless of other
  factors.
- **Audit trail** (`src/audit/`, `src/db/schema.sql`): every screening,
  import, and analyst disposition writes an immutable `audit_log` row.
  Screenings are never mutated — analyst review is a separate
  `dispositions` table, so the system's original output and the human
  decision are both preserved.
- **API** (`src/api/`): REST endpoints (see below). Storage is SQLite via
  `better-sqlite3`; the schema is plain SQL so moving to Postgres later is a
  driver swap, not a rewrite.

## API endpoints

| Method | Path | Purpose |
|---|---|---|
| POST | `/screen` | Screen one subject synchronously |
| POST | `/screen/batch` | Screen up to 500 subjects in one call |
| GET | `/screenings/:id` | Retrieve a past screening result |
| POST | `/screenings/:id/disposition` | Record analyst true/false-positive decision |
| GET | `/screenings/:id/audit` | Full audit trail for a screening |
| GET | `/screenings/pending-review?minBand=medium` | Screenings at/above a risk band with no conclusive disposition yet |
| GET | `/screenings/review-summary` | Count of pending-review screenings per risk band |
| GET | `/list-versions` | Current loaded version of each source list |
| GET | `/entities/:id` | Look up one stored watchlist entity |
| GET | `/health` | Liveness check |

Example:

```bash
curl -X POST http://localhost:3000/screen \
  -H "Content-Type: application/json" \
  -d '{"name": "Jonas Herrera", "dateOfBirth": "1978-03-11", "nationality": "VE"}'
```

## Corporate networks / TLS interception

If your network does transparent TLS interception (Zscaler, corporate SSL
inspection, etc.), every HTTPS request from Node will fail with `unable to
get local issuer certificate` — even though `curl` and browsers work fine,
since they read the OS certificate store and Node doesn't by default.

Check for this: `curl -v https://example.com` and look at the `issuer:` line.
If it names your company's security vendor instead of the site's real CA,
that's TLS interception. Fix it by pointing Node at the same CA bundle curl
uses (shown in curl's own `-v` output as `CAfile: ...`, commonly
`/etc/ssl/certs/ca-certificates.crt` on Debian/Ubuntu):

```bash
echo 'export NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt' >> ~/.bashrc
source ~/.bashrc
```

This has to be set in your shell before Node starts — `.env`/dotenv loads
too late to affect TLS initialization.

```bash
npx ts-node src/diagnose-network.ts
```

checks this first (since it explains a uniform failure across every source
far more often than proxy/firewall config does) and then checks each source
individually.

## Jurisdiction coverage

| Jurisdiction | Module | Notes |
|---|---|---|
| US (OFAC) | `ofac.ts` | Verified live schema |
| UN | `un.ts` | Verified live schema |
| EU | `eu.ts` | Verified; requires your own registered token (see `.env`) |
| UK | `uk.ts` | Verified live schema; replaced OFSI Consolidated List entirely as of 28 Jan 2026 |
| Japan | `jpMof.ts` | XLSX only; column mapping unverified, see caveat above |
| Singapore, Hong Kong | — | Neither publishes an autonomous consolidated list — both mostly re-publish the UN list you already have via `un.ts`. Not worth a dedicated module; use `openSanctions.ts` if you need their small supplementary lists and have a commercial license. |
| PEP (global) | `openSanctionsPep.ts` | Streams OpenSanctions' full FollowTheMoney export, filtered to `role.pep`/`role.rca`. Job name `OPENSANCTIONS_PEP`; run manually with `npx ts-node src/ingestion/scheduler.ts --run-once` or wait for its cron schedule. |

## Things to do before production use

1. **Verify source URLs and XML schemas** in `.env` and `src/normalize/mappers.ts`
   against the current live schemas — sanctions authorities revise these
   periodically, and this scaffold's field mappings should be checked against
   the authorities' current schema documentation before going live.
2. **License a PEP / adverse-media vendor** (Dow Jones, Refinitiv World-Check,
   Moody's, etc.) — there's no free comprehensive global PEP list. Adjust
   `src/ingestion/vendorFeed.ts` to the vendor's actual API contract.
3. **Scale the matching query.** `matchService.ts` currently does a full
   table scan against every stored entity per screening — fine for
   thousands of records, not for a full sanctions+PEP+adverse-media corpus
   (often 1M+ records). Add a blocking step (index by soundex/first-letter,
   or a dedicated search index like Elasticsearch/OpenSearch) before
   fuzzy-scoring candidates.
4. **Update the FATF jurisdiction lists** in `src/matching/scorer.ts` — the
   ones in this scaffold are illustrative placeholders.
5. **Add gRPC** if you want it alongside REST: define a `.proto` mirroring
   the REST payloads and add `@grpc/grpc-js` — the service layer
   (`matchService.ts`, `auditLog.ts`) is already decoupled from Express, so
   a gRPC server can call the same functions directly.
6. **Consider moving SQLite to Postgres** once you have concurrent writers
   at scale — the schema is plain SQL and the transaction pattern in
   `ingestion/types.ts` translates directly.

## Testing it locally

```bash
npm run migrate
node -e "require('ts-node/register'); require('./src/ingestion/custom').importCustomListFromFile('./samples/custom-list-sample.csv')"
curl -X POST http://localhost:3000/screen -H "Content-Type: application/json" \
  -d '{"name": "Jonas Herera", "dateOfBirth": "1978-03-11"}'
```
