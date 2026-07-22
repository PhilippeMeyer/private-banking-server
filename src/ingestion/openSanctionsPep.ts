import readline from "readline";
import crypto from "crypto";
import fs from "fs";
import { Readable } from "stream";
import { config } from "../config";
import { mapOpenSanctionsFtmEntity, OpenSanctionsFtmEntity } from "../normalize/mappers";
import { persistImport, ImportResult } from "./types";

/**
 * Imports OpenSanctions' full `entities.ftm.json` export (the "default"
 * collection, per their own recommendation — the standalone `peps`
 * collection is explicitly discouraged by OpenSanctions themselves, since
 * it drops enrichment data like relative/associate links and non-Latin
 * aliases) and keeps only entities tagged with the role.pep or role.rca
 * topic, per OpenSanctions' documented PEP identification method.
 *
 * Source: if config.sources.openSanctionsFtmFilePath is set, this reads that
 * local file directly (fs.createReadStream) — no network request is made at
 * all. Otherwise it fetches config.sources.openSanctionsFtmUrl over HTTP.
 * Either way, the file is one JSON object per line (no top-level array) and
 * can be very large for the full collection — this streams line-by-line
 * rather than buffering the whole thing into memory, and computes a
 * checksum incrementally for the same reason.
 *
 * LICENSING: read src/config.ts's comment on openSanctionsLicenseConfirmed
 * before enabling this. OpenSanctions' data is free for non-commercial use
 * under CC BY-NC 4.0; whether a given use qualifies as non-commercial is a
 * judgment call for you (and ideally your legal/compliance function) to
 * make — the license applies to the data itself, not to how you access it,
 * so reading a local copy of the file doesn't change this. This importer
 * requires an explicit opt-in either way, as a deliberate checkpoint rather
 * than a silent default.
 */
export async function importOpenSanctionsPep(): Promise<ImportResult> {
  if (!config.sources.openSanctionsLicenseConfirmed) {
    throw new Error(
      "OpenSanctions import blocked: set OPENSANCTIONS_LICENSE_CONFIRMED=true in .env " +
        "only after you've confirmed your use case is properly licensed or covered by " +
        "OpenSanctions' non-commercial exemption (CC BY-NC 4.0) — see " +
        "https://www.opensanctions.org/docs/commercial/exemption/ and " +
        "https://www.opensanctions.org/licensing/. This applies to the data itself, " +
        "regardless of whether you read it from a local file or fetch it live."
    );
  }

  const filePath = config.sources.openSanctionsFtmFilePath;
  const nodeStream = filePath ? await openLocalFileStream(filePath) : await openRemoteStream();

  const topicFilter = config.sources.openSanctionsPepTopics;
  const hash = crypto.createHash("sha256");
  const canonical: ReturnType<typeof mapOpenSanctionsFtmEntity>[] = [];

  let totalLines = 0;
  let schemaCounts: Record<string, number> = {};
  let parseErrors = 0;

  const rl = readline.createInterface({ input: nodeStream, crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line) continue;
    totalLines++;
    hash.update(line);

    let entity: OpenSanctionsFtmEntity;
    try {
      entity = JSON.parse(line);
    } catch {
      parseErrors++;
      continue;
    }

    schemaCounts[entity.schema] = (schemaCounts[entity.schema] ?? 0) + 1;

    const topics = entity.properties?.topics ?? [];
    const isMatch = topicFilter.some((t) => topics.includes(t));
    if (!isMatch) continue;

    canonical.push(mapOpenSanctionsFtmEntity(entity));
  }

  console.log(
    `[import] OpenSanctions FTM (source: ${filePath ? `local file ${filePath}` : "remote URL"}): ` +
      `scanned ${totalLines} lines, ` +
      `${Object.entries(schemaCounts).map(([s, n]) => `${s}=${n}`).join(", ")}, ` +
      `${parseErrors} parse errors, matched ${canonical.length} entities with topics [${topicFilter.join(", ")}]`
  );

  if (canonical.length === 0) {
    console.warn(
      "[import] OpenSanctions FTM: zero entities matched the PEP topic filter. " +
        "Check the source points at a dataset that includes PEP data (the " +
        "'default' collection, not a sanctions-only one) and that " +
        "OPENSANCTIONS_PEP_TOPICS matches OpenSanctions' current topic taxonomy."
    );
  }

  return persistImport("OPENSANCTIONS", canonical, hash.digest("hex"));
}

async function openLocalFileStream(filePath: string): Promise<NodeJS.ReadableStream> {
  if (!fs.existsSync(filePath)) {
    throw new Error(`OpenSanctions FTM file not found at ${filePath}`);
  }
  return fs.createReadStream(filePath, { encoding: "utf-8" });
}

async function openRemoteStream(): Promise<NodeJS.ReadableStream> {
  const res = await fetch(config.sources.openSanctionsFtmUrl, {
    headers: { "User-Agent": "kyc-screening-service/0.1 (compliance-import)" },
  });
  if (!res.ok) {
    throw new Error(`OpenSanctions FTM fetch failed: ${res.status} ${res.statusText}`);
  }
  if (!res.body) {
    throw new Error("OpenSanctions FTM fetch returned no response body to stream.");
  }
  return Readable.fromWeb(res.body as any);
}
