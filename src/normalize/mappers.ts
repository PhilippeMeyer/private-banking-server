import { CanonicalEntity, EntityKind } from "./entity";

/**
 * Each mapper takes one raw record (already parsed from XML/CSV/JSON by the
 * source-specific ingestion module) and returns a CanonicalEntity.
 *
 * NOTE: field paths below reflect the well-documented public schemas for these
 * lists as of the last time this was verified. Sanctions authorities do
 * periodically revise their XML schemas — if an import starts producing empty
 * fields, check the source's schema documentation before assuming the mapper
 * is wrong.
 */

function asArray<T>(v: T | T[] | undefined | null): T[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

// ---- OFAC (SDN / Consolidated) ----
// Source XML: <sdnEntry> with uid, firstName, lastName, sdnType, programList,
// idList, dateOfBirthList, nationalityList, addressList, akaList.
export function mapOfacEntry(raw: any, source: "OFAC_SDN" | "OFAC_CONSOLIDATED"): CanonicalEntity {
  const firstName = raw.firstName?.[0] ?? "";
  const lastName = raw.lastName?.[0] ?? "";
  const sdnType = (raw.sdnType?.[0] ?? "Individual") as string;

  const entityType: EntityKind =
    sdnType.toLowerCase() === "individual"
      ? "individual"
      : sdnType.toLowerCase() === "vessel"
      ? "vessel"
      : sdnType.toLowerCase() === "aircraft"
      ? "aircraft"
      : "organization";

  const akaList = asArray(raw.akaList?.[0]?.aka).map(
    (a: any) => `${a.firstName?.[0] ?? ""} ${a.lastName?.[0] ?? ""}`.trim()
  );

  const idList = asArray(raw.idList?.[0]?.id).map((id: any) => ({
    type: id.idType?.[0] ?? "other",
    number: id.idNumber?.[0] ?? "",
    country: id.idCountry?.[0],
  }));

  const nationalities = asArray(raw.nationalityList?.[0]?.nationality).map(
    (n: any) => n.country?.[0]
  ).filter(Boolean);

  const addresses = asArray(raw.addressList?.[0]?.address).map((a: any) => ({
    line: [a.address1?.[0], a.address2?.[0]].filter(Boolean).join(", "),
    city: a.city?.[0],
    country: a.country?.[0],
  }));

  const programs = asArray(raw.programList?.[0]?.program);

  const dobRaw = raw.dateOfBirthList?.[0]?.dateOfBirthItem?.[0]?.dateOfBirth?.[0];

  return {
    source,
    sourceRecordId: raw.uid?.[0] ?? "",
    entityType,
    primaryName: `${firstName} ${lastName}`.trim(),
    aliases: akaList.filter(Boolean),
    dateOfBirth: normalizeLooseDate(dobRaw),
    nationalities,
    idNumbers: idList,
    addresses,
    riskCategory: "sanctions",
    programs,
    rawData: raw,
  };
}

// ---- UN Consolidated List ----
// Source XML: <INDIVIDUAL> / <ENTITY> nodes with FIRST_NAME, SECOND_NAME,
// THIRD_NAME, UN_LIST_TYPE, INDIVIDUAL_ALIAS, NATIONALITY, INDIVIDUAL_DATE_OF_BIRTH.
export function mapUnEntry(raw: any, kind: "individual" | "entity"): CanonicalEntity {
  const nameParts = [raw.FIRST_NAME?.[0], raw.SECOND_NAME?.[0], raw.THIRD_NAME?.[0]]
    .filter(Boolean)
    .join(" ");

  const aliasField = kind === "individual" ? raw.INDIVIDUAL_ALIAS : raw.ENTITY_ALIAS;
  const aliases = asArray(aliasField).map((a: any) => a.ALIAS_NAME?.[0]).filter(Boolean);

  const nationalities = asArray(raw.NATIONALITY?.[0]?.VALUE);

  const dobEntries = asArray(raw.INDIVIDUAL_DATE_OF_BIRTH);
  const dob = dobEntries[0]?.DATE?.[0] ?? dobEntries[0]?.YEAR?.[0];

  return {
    source: "UN",
    sourceRecordId: raw.DATAID?.[0] ?? raw.REFERENCE_NUMBER?.[0] ?? "",
    entityType: kind === "individual" ? "individual" : "organization",
    primaryName: nameParts || raw.FIRST_NAME?.[0] || "Unknown",
    aliases,
    dateOfBirth: normalizeLooseDate(dob),
    nationalities,
    idNumbers: [],
    addresses: [],
    riskCategory: "sanctions",
    programs: asArray(raw.UN_LIST_TYPE?.[0]),
    rawData: raw,
  };
}

// ---- EU Consolidated Financial Sanctions List ----
// Source XML: <sanctionEntity> with subjectType, nameAlias, birthdate, citizenship.
export function mapEuEntry(raw: any): CanonicalEntity {
  const nameAliases = asArray(raw.nameAlias);
  const wholeNames = nameAliases.map((na: any) => na?.$?.wholeName).filter(Boolean);

  const subjectType = raw?.subjectType?.[0]?.$?.classificationCode ?? "person";
  const entityType: EntityKind = subjectType.toLowerCase().includes("person")
    ? "individual"
    : "organization";

  const birthdates = asArray(raw.birthdate).map((b: any) => b?.$?.birthdate).filter(Boolean);
  const citizenships = asArray(raw.citizenship).map((c: any) => c?.$?.countryDescription).filter(Boolean);

  return {
    source: "EU",
    sourceRecordId: raw?.$?.euReferenceNumber ?? raw?.$?.logicalId ?? "",
    entityType,
    primaryName: wholeNames[0] ?? "Unknown",
    aliases: wholeNames.slice(1),
    dateOfBirth: normalizeLooseDate(birthdates[0]),
    nationalities: citizenships,
    idNumbers: [],
    addresses: [],
    riskCategory: "sanctions",
    programs: [],
    rawData: raw,
  };
}

// ---- UK Sanctions List (UKSL) ----
// Source XML: <Designations><Designation> with UniqueID (the canonical id as
// of the Jan 2026 OFSI->UKSL consolidation; OFSIGroupID is legacy/optional),
// Names/Name (Name1..Name6 + NameType), IndividualEntityShip, IndividualDetails
// with DOBs/PassportDetails/Nationalities/NationalIdentifierDetails.
// Verified directly against the live file at sanctionslist.fcdo.gov.uk.
export function mapUkEntry(raw: any): CanonicalEntity {
  const namesRaw = asArray(raw.Names?.[0]?.Name);

  function assembleName(n: any): string {
    // UK's schema splits name components across Name1..Name6 in a
    // non-obvious order (Name6 often holds the primary surname/org name
    // while Name1-5 hold given names) — concatenate in field order and let
    // the source's own ordering stand rather than reordering, since reason
    // for the ordering isn't standardized across individuals vs entities.
    return [n.Name1?.[0], n.Name2?.[0], n.Name3?.[0], n.Name4?.[0], n.Name5?.[0], n.Name6?.[0]]
      .map((p: string | undefined) => p?.trim())
      .filter(Boolean)
      .join(" ");
  }

  const primaryNameEntry = namesRaw.find(
    (n: any) => n.NameType?.[0] === "Primary Name"
  );
  const aliasEntries = namesRaw.filter((n: any) => n.NameType?.[0] !== "Primary Name");

  const shipType = raw.IndividualEntityShip?.[0] ?? "Entity";
  const entityType: EntityKind =
    shipType === "Individual" ? "individual" : shipType === "Ship" ? "vessel" : "organization";

  const addresses = asArray(raw.Addresses?.[0]?.Address).map((a: any) => ({
    line: [a.AddressLine1?.[0], a.AddressLine2?.[0], a.AddressLine3?.[0], a.AddressLine4?.[0]]
      .filter(Boolean)
      .join(", "),
    city: a.AddressLine5?.[0] ?? a.AddressLine6?.[0],
    country: a.AddressCountry?.[0],
  }));

  const individual = raw.IndividualDetails?.[0]?.Individual?.[0];

  const idNumbers: { type: string; number: string; country?: string }[] = [];
  if (individual) {
    for (const p of asArray(individual.PassportDetails?.[0]?.Passport)) {
      if (p.PassportNumber?.[0]) {
        idNumbers.push({ type: "passport", number: p.PassportNumber[0].trim() });
      }
    }
    for (const ni of asArray(individual.NationalIdentifierDetails?.[0]?.NationalIdentifier)) {
      if (ni.NationalIdentifierNumber?.[0]) {
        idNumbers.push({ type: "national_id", number: ni.NationalIdentifierNumber[0].trim() });
      }
    }
  }

  const nationalities = asArray(individual?.Nationalities?.[0]?.Nationality);

  // DOBs use dd/mm/yyyy, sometimes with literal "dd"/"mm" placeholders for
  // an unknown day/month (e.g. "dd/mm/1945") — normalizeLooseDate passes
  // those through unchanged rather than misparsing them.
  const dobs = asArray(individual?.DOBs?.[0]?.DOB);
  const dateOfBirth = normalizeLooseDate(dobs[0]);

  const birthLocations = asArray(individual?.BirthDetails?.[0]?.Location);
  const placeOfBirth = birthLocations[0]?.TownOfBirth?.[0];

  const programs = [raw.RegimeName?.[0]].filter(Boolean);
  const sanctionsImposed = (raw.SanctionsImposed?.[0] ?? "")
    .split("|")
    .map((s: string) => s.trim())
    .filter(Boolean);

  return {
    source: "UK",
    // UniqueID is the canonical identifier post-Jan-2026 consolidation.
    // OFSIGroupID is retained in rawData for continuity on older records but
    // is no longer issued for new designations, so it isn't used as the key.
    sourceRecordId: raw.UniqueID?.[0] ?? "",
    entityType,
    primaryName: primaryNameEntry ? assembleName(primaryNameEntry) : "Unknown",
    aliases: aliasEntries.map(assembleName).filter(Boolean),
    dateOfBirth,
    placeOfBirth,
    nationalities,
    idNumbers,
    addresses,
    riskCategory: "sanctions",
    programs: [...programs, ...sanctionsImposed],
    rawData: raw,
  };
}


// ---- Japan Ministry of Finance (MOF) Economic Sanctions List ----
// Source is an XLSX file (not XML/JSON) published at mof.go.jp, in Japanese.
// IMPORTANT: the column names below are a caller-supplied mapping, NOT
// hardcoded guesses — this project's tooling could not parse the live
// binary XLSX during development to confirm real header names. Before
// relying on this in production, open the actual downloaded file, confirm
// the real header row (likely Japanese-language), and set JP_MOF_COLUMN_MAP
// accordingly (see config.ts). This mapper is intentionally tolerant:
// unmapped columns are preserved in rawData rather than dropped.
export interface JpMofColumnMap {
  name: string; // column holding the sanctioned individual/entity's name
  aliases?: string;
  dateOfBirth?: string;
  nationality?: string;
  address?: string;
  program?: string; // which sanctions program/regime this entry falls under
}

export function mapJpMofRow(raw: Record<string, any>, columnMap: JpMofColumnMap): CanonicalEntity {
  const name = raw[columnMap.name] ?? "Unknown";
  const aliases = columnMap.aliases
    ? String(raw[columnMap.aliases] ?? "")
        .split(/[;,、]/) // handles Japanese full-width comma too
        .map((s) => s.trim())
        .filter(Boolean)
    : [];

  return {
    source: "JP_MOF",
    // No single documented stable ID column was confirmed for this source;
    // ingestion/jpMof.ts supplies a row index as __rowIndex.
    sourceRecordId: String(raw.__rowIndex ?? ""),
    entityType: "individual", // MOF list mixes individuals/entities; refine once real columns are confirmed
    primaryName: String(name).trim(),
    aliases,
    dateOfBirth: columnMap.dateOfBirth ? normalizeLooseDate(raw[columnMap.dateOfBirth]) : undefined,
    nationalities: columnMap.nationality ? [String(raw[columnMap.nationality])].filter(Boolean) : [],
    idNumbers: [],
    addresses: columnMap.address ? [{ line: String(raw[columnMap.address]) }] : [],
    riskCategory: "sanctions",
    programs: columnMap.program ? [String(raw[columnMap.program])].filter(Boolean) : [],
    rawData: raw,
  };
}

// ---- OpenSanctions (aggregator) ----
// targets.simple.csv columns per OpenSanctions' documented format and
// changelog: id, schema, name, aliases, birth_date, countries, addresses,
// identifiers, sanctions, phones, emails, dataset, program_ids, first_seen,
// last_seen, last_change. OpenSanctions has changed this format before
// (program_ids was added later) — importOpenSanctions() logs the actual
// header row it receives so a mismatch is visible immediately.
//
// LICENSING: OpenSanctions bulk/API data is free for non-commercial use only.
// A private bank's KYC screening use is commercial use and requires a paid
// license from OpenSanctions — see ingestion/openSanctions.ts for the
// confirmation gate this project requires before this importer will run.
export function mapOpenSanctionsRow(raw: Record<string, any>): CanonicalEntity {
  const schema = (raw.schema ?? "").toLowerCase();
  const entityType: EntityKind =
    schema === "person" ? "individual" : schema === "vessel" ? "vessel" : "organization";

  const splitMulti = (v: string | undefined) =>
    (v ?? "")
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean);

  return {
    source: "OPENSANCTIONS",
    sourceRecordId: raw.id ?? "",
    entityType,
    primaryName: raw.name ?? "Unknown",
    aliases: splitMulti(raw.aliases),
    dateOfBirth: normalizeLooseDate(raw.birth_date),
    nationalities: splitMulti(raw.countries),
    idNumbers: splitMulti(raw.identifiers).map((id) => ({ type: "other", number: id })),
    addresses: splitMulti(raw.addresses).map((line) => ({ line })),
    riskCategory: "sanctions",
    programs: [...splitMulti(raw.dataset), ...splitMulti(raw.program_ids)],
    rawData: raw,
  };
}

// ---- OpenSanctions (FollowTheMoney entity stream, PEP-focused) ----
// entities.ftm.json is one JSON object per line: { id, schema, caption,
// datasets, properties: { name, alias, birthDate, nationality, country,
// topics, ... } }. PEP identification per OpenSanctions' own docs: "All
// PEPs have the role.pep topic in their topics property." Verified against
// OpenSanctions' published entity-structure documentation.
export interface OpenSanctionsFtmEntity {
  id: string;
  schema: string;
  caption?: string;
  datasets?: string[];
  first_seen?: string;
  last_change?: string;
  properties?: Record<string, string[]>;
}

export function mapOpenSanctionsFtmEntity(entity: OpenSanctionsFtmEntity): CanonicalEntity {
  const props = entity.properties ?? {};
  const get = (key: string): string[] => props[key] ?? [];

  const entityType: EntityKind =
    entity.schema === "Person" ? "individual" : entity.schema === "Vessel" ? "vessel" : "organization";

  const aliases = [...get("alias"), ...get("weakAlias")];
  const nationalities = [...get("nationality"), ...get("country")];
  const topics = get("topics");

  return {
    source: "OPENSANCTIONS",
    sourceRecordId: entity.id,
    entityType,
    primaryName: entity.caption ?? get("name")[0] ?? "Unknown",
    aliases,
    dateOfBirth: normalizeLooseDate(get("birthDate")[0]),
    nationalities: [...new Set(nationalities)],
    idNumbers: [],
    addresses: get("address").map((line) => ({ line })),
    // PEP status is a topic tag (role.pep / role.rca), not a separate
    // schema, so riskCategory reflects that rather than a hardcoded value.
    riskCategory: topics.includes("role.pep") || topics.includes("role.rca") ? "pep" : "sanctions",
    programs: [...(entity.datasets ?? []), ...topics],
    rawData: entity,
  };
}



// This mapper assumes a reasonably generic JSON shape; adjust field names to
// match whichever vendor contract you sign.
export function mapVendorRecord(
  raw: any,
  riskCategory: "pep" | "adverse_media"
): CanonicalEntity {
  return {
    source: "PEP",
    sourceRecordId: raw.id ?? raw.recordId ?? "",
    entityType: raw.type === "organization" ? "organization" : "individual",
    primaryName: raw.name ?? raw.fullName ?? "Unknown",
    aliases: asArray(raw.aliases),
    dateOfBirth: normalizeLooseDate(raw.dateOfBirth),
    placeOfBirth: raw.placeOfBirth,
    nationalities: asArray(raw.nationalities ?? raw.nationality),
    idNumbers: asArray(raw.idNumbers).map((id: any) => ({
      type: id.type ?? "other",
      number: id.number ?? "",
      country: id.country,
    })),
    addresses: asArray(raw.addresses),
    riskCategory,
    programs: asArray(raw.categories ?? raw.riskTags),
    rawData: raw,
  };
}

// ---- Custom lists (CSV/JSON uploaded by the bank's own compliance team) ----
export function mapCustomRecord(raw: any): CanonicalEntity {
  return {
    source: "CUSTOM",
    sourceRecordId: raw.id ?? "",
    entityType: (raw.entityType as EntityKind) ?? "individual",
    primaryName: raw.name ?? "Unknown",
    aliases: asArray(raw.aliases),
    dateOfBirth: normalizeLooseDate(raw.dateOfBirth),
    nationalities: asArray(raw.nationality),
    idNumbers: asArray(raw.idNumbers),
    addresses: asArray(raw.addresses),
    riskCategory: "custom",
    programs: asArray(raw.tags),
    rawData: raw,
  };
}

// Sanctions lists frequently give partial dates (year only, or DD/MM/YYYY vs
// YYYY-MM-DD depending on source). Normalize to ISO where possible, otherwise
// pass through the raw string so nothing is silently dropped.
function normalizeLooseDate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const isoLike = /^\d{4}-\d{2}-\d{2}$/;
  if (isoLike.test(value)) return value;

  const ddMonYyyy = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;
  const match = value.match(ddMonYyyy);
  if (match) {
    const [, d, m, y] = match;
    return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }

  return value; // leave as-is (e.g. year-only "1975") rather than guessing
}
