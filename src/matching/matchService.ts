import { v4 as uuid } from "uuid";
import { getDb } from "../db/client";
import { config } from "../config";
import { nameSimilarity } from "./fuzzy";
import { scoreRisk } from "./scorer";
import { MatchResult, ScreeningResult, ScreeningSubject } from "../normalize/entity";

interface EntityRow {
  id: string;
  source: string;
  primary_name: string;
  aliases: string;
  date_of_birth: string | null;
  id_numbers: string;
  nationalities: string;
  risk_category: string;
  list_version_id: string;
}

// Common country name -> ISO 3166-1 alpha-2 mappings, covering the countries
// that actually show up in sanctions/PEP data most often. Not exhaustive —
// extend as needed. Used only to corroborate (not gate) a name match: a
// subject-provided nationality matching a candidate's stored nationality is
// modest positive evidence; a confident mismatch is modest negative
// evidence. This is what stops a short, common name fragment (e.g. "Pen")
// from ranking a Cambodian politician above a French one when the caller
// actually told us which country they meant.
const COUNTRY_NAME_TO_CODE: Record<string, string> = {
  "united states": "US", "united states of america": "US", usa: "US",
  "united kingdom": "GB", uk: "GB", "great britain": "GB",
  france: "FR", germany: "DE", italy: "IT", spain: "ES", portugal: "PT",
  netherlands: "NL", belgium: "BE", switzerland: "CH", austria: "AT",
  poland: "PL", ukraine: "UA", russia: "RU", "russian federation": "RU",
  belarus: "BY", georgia: "GE", moldova: "MD", turkey: "TR",
  china: "CN", taiwan: "TW", japan: "JP", "south korea": "KR", korea: "KR",
  "north korea": "KP", "democratic people's republic of korea": "KP",
  vietnam: "VN", cambodia: "KH", myanmar: "MM", burma: "MM",
  india: "IN", pakistan: "PK", afghanistan: "AF",
  iran: "IR", iraq: "IQ", syria: "SY", yemen: "YE", lebanon: "LB",
  "saudi arabia": "SA", "united arab emirates": "AE", uae: "AE",
  israel: "IL", egypt: "EG", libya: "LY", sudan: "SD", "south sudan": "SS",
  somalia: "SO", mali: "ML", nigeria: "NG",
  "democratic republic of the congo": "CD", congo: "CD",
  "central african republic": "CF", zimbabwe: "ZW", "south africa": "ZA",
  venezuela: "VE", cuba: "CU", nicaragua: "NI", haiti: "HT",
  brazil: "BR", mexico: "MX", argentina: "AR", colombia: "CO",
  singapore: "SG", "hong kong": "HK", malaysia: "MY", thailand: "TH",
  indonesia: "ID", philippines: "PH",
  canada: "CA", australia: "AU",
};

function normalizeCountryToken(raw: string | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (/^[A-Za-z]{2}$/.test(trimmed)) return trimmed.toUpperCase();
  return COUNTRY_NAME_TO_CODE[trimmed.toLowerCase()] ?? null;
}

// Supranational/non-specific codes that some sources (OpenSanctions/Wikidata
// notably) use instead of a member state when the specific country isn't
// populated — e.g. an EU-level politician tagged "eu" rather than their
// actual nationality. Treating "eu" as a real country for comparison would
// wrongly penalize a genuine match (a French politician tagged only "eu"
// scored as a "confident mismatch" against a query for "FR"). These codes
// rather than evidence against the match.
const NON_SPECIFIC_COUNTRY_CODES = new Set(["EU", "UN", "INT", "XX"]);

/**
 * Screens one subject against every stored entity. For a production dataset
 * of hundreds of thousands of sanctions/PEP records, replace this full-table
 * scan with a blocking step first (e.g. index by first letter + soundex code,
 * or use a dedicated matching engine/search index) before fuzzy-scoring
 * candidates. Correctness here; scale is a follow-up optimization.
 */
export function screenSubject(
  subject: ScreeningSubject,
  requestedBy?: string
): ScreeningResult & { screeningId: string } {
  const db = getDb();
  // Only match against the LATEST imported version per source. Every past
  // import is still kept in full (list_versions + entities are never
  // deleted, for audit purposes — see ingestion/types.ts), but re-running
  // an import creates a new list_version_id without removing the old one,
  // so matching against the whole entities table would multiply-count the
  // same real-world person once per historical import run.
  const rows = db
    .prepare(
      `WITH latest_versions AS (
         SELECT lv.source, lv.id AS list_version_id
         FROM list_versions lv
         WHERE lv.imported_at = (
           SELECT MAX(lv2.imported_at) FROM list_versions lv2 WHERE lv2.source = lv.source
         )
       )
       SELECT e.id, e.source, e.primary_name, e.aliases, e.date_of_birth, e.id_numbers,
              e.nationalities, e.risk_category, e.list_version_id
       FROM entities e
       JOIN latest_versions v ON v.source = e.source AND v.list_version_id = e.list_version_id`
    )
    .all() as EntityRow[];

  const subjectNationalityCode = normalizeCountryToken(subject.nationality);

  const matches: MatchResult[] = [];

  for (const row of rows) {
    const aliases: string[] = JSON.parse(row.aliases || "[]");
    const namesToCheck = [row.primary_name, ...aliases];

    let best = { score: 0, matchedName: row.primary_name };
    for (const candidateName of namesToCheck) {
      const { score } = nameSimilarity(subject.name, candidateName);
      if (score > best.score) best = { score, matchedName: candidateName };
    }

    if (best.score < config.matching.reviewThreshold) continue;

    const matchedOn: string[] = ["name_fuzzy"];
    let adjustedScore = best.score;

    // Exact DOB match on an already-plausible name match materially raises
    // confidence; a DOB mismatch on a borderline name lowers it.
    if (subject.dateOfBirth && row.date_of_birth) {
      if (subject.dateOfBirth === row.date_of_birth) {
        adjustedScore = Math.min(1, adjustedScore + 0.1);
        matchedOn.push("dob_exact");
      } else {
        adjustedScore = Math.max(0, adjustedScore - 0.1);
      }
    }

    // Nationality corroboration: modest boost when the subject-provided
    // nationality matches one of the candidate's stored nationalities,
    // modest penalty on a confident mismatch. This is what keeps a common
    // name fragment shared across languages (e.g. "Pen") from outranking
    // the actual target once the caller tells us which country they mean —
    // it's corroborating evidence, not a hard filter, since nationality
    // data is often incomplete and dual nationals are common.
    if (subjectNationalityCode) {
      const entityNationalities: string[] = JSON.parse(row.nationalities || "[]");
      const entityCodes = entityNationalities
        .map((n) => normalizeCountryToken(n))
        .filter((c): c is string => c !== null && !NON_SPECIFIC_COUNTRY_CODES.has(c));

      if (entityCodes.length > 0) {
        if (entityCodes.includes(subjectNationalityCode)) {
          adjustedScore = Math.min(1, adjustedScore + 0.08);
          matchedOn.push("nationality_match");
        } else {
          adjustedScore = Math.max(0, adjustedScore - 0.12);
        }
      }
    }

    // Exact ID number match (passport/national ID/tax ID) is near-conclusive.
    if (subject.idNumbers?.length) {
      const storedIds: { type: string; number: string }[] = JSON.parse(row.id_numbers || "[]");
      const idHit = subject.idNumbers.some((sid) =>
        storedIds.some((rid) => rid.number && rid.number === sid.number)
      );
      if (idHit) {
        adjustedScore = 0.99;
        matchedOn.push("id_exact");
      }
    }

    if (adjustedScore < config.matching.reviewThreshold) continue;

    matches.push({
      entityId: row.id,
      source: row.source as MatchResult["source"],
      riskCategory: row.risk_category as MatchResult["riskCategory"],
      primaryName: row.primary_name,
      matchedName: best.matchedName,
      score: adjustedScore,
      matchedOn: best.matchedName !== row.primary_name ? [...matchedOn, "via_alias"] : matchedOn,
    });
  }

  matches.sort((a, b) => b.score - a.score);

  const { riskScore, riskBand } = scoreRisk({ matches, subjectNationality: subject.nationality });

  const screeningId = uuid();
  const now = new Date().toISOString();
  const listVersionsUsed = [...new Set(rows.map((r) => r.list_version_id))];

  db.prepare(
    `INSERT INTO screenings
      (id, subject_name, subject_dob, subject_nationality, subject_id_numbers,
       requested_by, requested_at, risk_score, risk_band, matches, list_versions_used)
     VALUES (@id, @name, @dob, @nationality, @idNumbers, @requestedBy, @requestedAt,
       @riskScore, @riskBand, @matches, @listVersionsUsed)`
  ).run({
    id: screeningId,
    name: subject.name,
    dob: subject.dateOfBirth ?? null,
    nationality: subject.nationality ?? null,
    idNumbers: JSON.stringify(subject.idNumbers ?? []),
    requestedBy: requestedBy ?? null,
    requestedAt: now,
    riskScore,
    riskBand,
    matches: JSON.stringify(matches),
    listVersionsUsed: JSON.stringify(listVersionsUsed),
  });

  db.prepare(
    `INSERT INTO audit_log (id, entity_type, entity_id, action, actor, details, created_at)
     VALUES (@id, 'screening', @screeningId, 'created', @actor, @details, @createdAt)`
  ).run({
    id: uuid(),
    screeningId,
    actor: requestedBy ?? "unknown",
    details: JSON.stringify({ riskScore, riskBand, matchCount: matches.length }),
    createdAt: now,
  });

  return { screeningId, riskScore, riskBand, matches };
}
