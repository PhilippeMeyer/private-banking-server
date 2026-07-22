import { getDb } from "./db/client";
import { nameSimilarity } from "./matching/fuzzy";
import { config } from "./config";

const db = getDb();

// Exact same query screenSubject() uses.
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
  .all() as any[];

console.log("Total rows returned by the exact matching query:", rows.length);

const marineRows = rows.filter((r) => r.primary_name === "Marine Le Pen");
console.log("Marine Le Pen rows found in the query result:", marineRows.length);

if (marineRows.length === 0) {
  console.log("❌ She is NOT in the row set screenSubject() actually queries.");
  console.log("This means the JOIN/latest-version logic excludes her despite the");
  console.log("standalone check showing is_latest=1 — checking for duplicate");
  console.log("list_versions rows for source=OPENSANCTIONS with colliding timestamps...");

  const versions = db
    .prepare(`SELECT id, imported_at, record_count FROM list_versions WHERE source = 'OPENSANCTIONS' ORDER BY imported_at DESC`)
    .all();
  console.log("All OPENSANCTIONS list_versions:", JSON.stringify(versions, null, 2));
} else {
  const row = marineRows[0];
  console.log("\n✅ Found her row. Walking through scoring logic exactly as screenSubject does:\n");

  const aliases: string[] = JSON.parse(row.aliases || "[]");
  const namesToCheck = [row.primary_name, ...aliases];

  let best = { score: 0, matchedName: row.primary_name };
  for (const candidateName of namesToCheck) {
    const { score } = nameSimilarity("Le Pen", candidateName);
    if (score > best.score) best = { score, matchedName: candidateName };
  }
  console.log("Step 1 — best name-similarity score across primary_name + all aliases:", best);
  console.log("Review threshold:", config.matching.reviewThreshold);
  console.log("Passes initial threshold check?", best.score >= config.matching.reviewThreshold);

  let adjustedScore = best.score;

  // No DOB provided in this test subject, so that block is skipped — confirm:
  console.log("\nStep 2 — DOB adjustment: subject.dateOfBirth is undefined, block skipped (expected).");

  // Nationality block
  const subjectNationalityCode = "FR";
  const entityNationalities: string[] = JSON.parse(row.nationalities || "[]");
  console.log("\nStep 3 — nationality block:");
  console.log("  row.nationalities raw:", row.nationalities);
  console.log("  parsed entityNationalities:", entityNationalities);

  let adjustedScoreAfterNat = adjustedScore;
  console.log("  adjustedScore BEFORE nationality block:", adjustedScoreAfterNat);

  const NON_SPECIFIC_COUNTRY_CODES = new Set(["EU", "UN", "INT", "XX"]);
  function normalizeCountryToken(raw: string | undefined): string | null {
    if (!raw) return null;
    const trimmed = raw.trim();
    if (/^[A-Za-z]{2}$/.test(trimmed)) return trimmed.toUpperCase();
    return null;
  }
  const entityCodes = entityNationalities
    .map((n) => normalizeCountryToken(n))
    .filter((c): c is string => c !== null && !NON_SPECIFIC_COUNTRY_CODES.has(c));
  console.log("  entityCodes after normalize+filter:", entityCodes);
  console.log("  entityCodes.length > 0 ?", entityCodes.length > 0);

  if (entityCodes.length > 0) {
    if (entityCodes.includes(subjectNationalityCode)) {
      adjustedScoreAfterNat = Math.min(1, adjustedScoreAfterNat + 0.08);
      console.log("  -> BOOSTED to", adjustedScoreAfterNat);
    } else {
      adjustedScoreAfterNat = Math.max(0, adjustedScoreAfterNat - 0.12);
      console.log("  -> PENALIZED to", adjustedScoreAfterNat);
    }
  } else {
    console.log("  -> no adjustment (expected, since her only country is 'eu')");
  }

  console.log("\nFinal adjustedScore:", adjustedScoreAfterNat);
  console.log("Final threshold check — would she be INCLUDED?", adjustedScoreAfterNat >= config.matching.reviewThreshold);
}