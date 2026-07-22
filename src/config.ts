import dotenv from "dotenv";
dotenv.config();

function env(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v === undefined || v === "") {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return v;
}

export const config = {
  port: parseInt(env("PORT", "3000"), 10),
  nodeEnv: env("NODE_ENV", "development"),
  sqlitePath: env("SQLITE_PATH", "./data/kyc.db"),

  sources: {
    ofacSdnUrl: env("OFAC_SDN_XML_URL", ""),
    ofacConsolidatedUrl: env("OFAC_CONSOLIDATED_XML_URL", ""),
    unConsolidatedUrl: env("UN_CONSOLIDATED_XML_URL", ""),
    euConsolidatedUrl: env("EU_CONSOLIDATED_XML_URL", ""),
    ukSanctionsListUrl: env("UK_SANCTIONS_LIST_XML_URL", ""),
    jpMofXlsxUrl: env("JP_MOF_XLSX_URL", ""),
    jpMofColumnMap: {
      name: env("JP_MOF_COLUMN_NAME", "Name"),
      aliases: process.env.JP_MOF_COLUMN_ALIASES || undefined,
      dateOfBirth: process.env.JP_MOF_COLUMN_DOB || undefined,
      nationality: process.env.JP_MOF_COLUMN_NATIONALITY || undefined,
      address: process.env.JP_MOF_COLUMN_ADDRESS || undefined,
      program: process.env.JP_MOF_COLUMN_PROGRAM || undefined,
    },
    openSanctionsCsvUrl: env("OPENSANCTIONS_CSV_URL", ""),
    // Full "default" collection FollowTheMoney entity stream, filtered to
    // PEP-tagged entities on import — see ingestion/openSanctionsPep.ts for
    // why this (not the standalone `peps` collection) is what OpenSanctions
    // itself recommends for PEP use cases.
    // If openSanctionsFtmFilePath is set, the importer reads that local file
    // instead of fetching openSanctionsFtmUrl — no network request at all.
    openSanctionsFtmFilePath: env("OPENSANCTIONS_FTM_FILE_PATH", ""),
    openSanctionsFtmUrl: env(
      "OPENSANCTIONS_FTM_URL",
      "https://data.opensanctions.org/datasets/latest/default/entities.ftm.json"
    ),
    openSanctionsPepTopics: env("OPENSANCTIONS_PEP_TOPICS", "role.pep,role.rca")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    openSanctionsLicenseConfirmed: env("OPENSANCTIONS_LICENSE_CONFIRMED", "false") === "true",
    pepVendorUrl: env("PEP_VENDOR_API_URL", ""),
    pepVendorKey: env("PEP_VENDOR_API_KEY", ""),
    adverseMediaUrl: env("ADVERSE_MEDIA_VENDOR_API_URL", ""),
    adverseMediaKey: env("ADVERSE_MEDIA_VENDOR_API_KEY", ""),
  },

  cron: {
    ofac: env("IMPORT_CRON_OFAC", "0 3 * * *"),
    un: env("IMPORT_CRON_UN", "0 3 * * *"),
    eu: env("IMPORT_CRON_EU", "0 3 * * *"),
    uk: env("IMPORT_CRON_UK", "0 3 * * *"),
    jpMof: env("IMPORT_CRON_JP_MOF", "0 4 * * *"),
    openSanctions: env("IMPORT_CRON_OPENSANCTIONS", "0 6 * * *"),
    pep: env("IMPORT_CRON_PEP", "0 4 * * *"),
    adverseMedia: env("IMPORT_CRON_ADVERSE_MEDIA", "0 5 * * *"),
  },

  matching: {
    matchThreshold: parseFloat(env("FUZZY_MATCH_THRESHOLD", "0.82")),
    reviewThreshold: parseFloat(env("FUZZY_MATCH_REVIEW_THRESHOLD", "0.65")),
  },
};
