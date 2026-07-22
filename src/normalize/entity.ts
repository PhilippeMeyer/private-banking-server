export type SourceName =
  | "OFAC_SDN"
  | "OFAC_CONSOLIDATED"
  | "UN"
  | "EU"
  | "UK"
  | "JP_MOF"
  | "OPENSANCTIONS"
  | "PEP"
  | "ADVERSE_MEDIA"
  | "CUSTOM";

export type EntityKind = "individual" | "organization" | "vessel" | "aircraft";

export type RiskCategory = "sanctions" | "pep" | "adverse_media" | "custom";

export interface IdNumber {
  type: string; // 'passport' | 'national_id' | 'tax_id' | 'other'
  number: string;
  country?: string;
}

export interface Address {
  line?: string;
  city?: string;
  country?: string;
}

/**
 * Canonical shape that every source's raw record gets mapped into.
 * This is the ONLY shape the matching engine ever needs to understand,
 * so adding a new source means writing one mapper, not touching matching logic.
 */
export interface CanonicalEntity {
  source: SourceName;
  sourceRecordId: string;
  entityType: EntityKind;
  primaryName: string;
  aliases: string[];
  dateOfBirth?: string; // ISO date; many sanctions entries only have a year
  placeOfBirth?: string;
  nationalities: string[];
  idNumbers: IdNumber[];
  addresses: Address[];
  riskCategory: RiskCategory;
  programs: string[]; // e.g. sanctions program codes, PEP category, etc.
  rawData: unknown; // original record, preserved verbatim for audit
}

export interface ScreeningSubject {
  name: string;
  dateOfBirth?: string;
  nationality?: string;
  idNumbers?: IdNumber[];
}

export interface MatchResult {
  entityId: string;
  source: SourceName;
  riskCategory: RiskCategory;
  primaryName: string; // the entity's canonical/display name
  matchedName: string; // whichever name variant (primary or alias) scored best
  score: number; // 0..1 combined confidence
  matchedOn: string[]; // e.g. ['name_fuzzy', 'dob_exact', 'id_exact']
}

export type RiskBand = "low" | "medium" | "high";

export interface ScreeningResult {
  riskScore: number; // 0..1
  riskBand: RiskBand;
  matches: MatchResult[];
}
