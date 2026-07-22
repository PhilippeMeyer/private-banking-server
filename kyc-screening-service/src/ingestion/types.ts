import { v4 as uuid } from "uuid";
import { getDb } from "../db/client";
import { CanonicalEntity, SourceName } from "../normalize/entity";
import crypto from "crypto";

export interface ImportResult {
  source: SourceName;
  listVersionId: string;
  recordCount: number;
}

/**
 * Persists one completed import: writes a list_versions row, then all
 * canonical entities tied to that version. Runs in a single transaction so a
 * failed import never leaves a partial list_version behind.
 */
export function persistImport(
  source: SourceName,
  entities: CanonicalEntity[],
  rawPayloadForChecksum: string,
  versionLabel?: string
): ImportResult {
  const db = getDb();
  const listVersionId = uuid();
  const checksum = crypto.createHash("sha256").update(rawPayloadForChecksum).digest("hex");
  const now = new Date().toISOString();

  const insertVersion = db.prepare(
    `INSERT INTO list_versions (id, source, version_label, record_count, imported_at, checksum, status)
     VALUES (@id, @source, @versionLabel, @recordCount, @importedAt, @checksum, 'complete')`
  );

  const insertEntity = db.prepare(
    `INSERT OR REPLACE INTO entities
      (id, source, source_record_id, list_version_id, entity_type, primary_name, aliases,
       date_of_birth, place_of_birth, nationalities, id_numbers, addresses, risk_category,
       programs, raw_data, created_at)
     VALUES
      (@id, @source, @sourceRecordId, @listVersionId, @entityType, @primaryName, @aliases,
       @dateOfBirth, @placeOfBirth, @nationalities, @idNumbers, @addresses, @riskCategory,
       @programs, @rawData, @createdAt)`
  );

  const runAll = db.transaction((rows: CanonicalEntity[]) => {
    insertVersion.run({
      id: listVersionId,
      source,
      versionLabel: versionLabel ?? null,
      recordCount: rows.length,
      importedAt: now,
      checksum,
    });

    for (const e of rows) {
      insertEntity.run({
        id: uuid(),
        source: e.source,
        sourceRecordId: e.sourceRecordId,
        listVersionId,
        entityType: e.entityType,
        primaryName: e.primaryName,
        aliases: JSON.stringify(e.aliases),
        dateOfBirth: e.dateOfBirth ?? null,
        placeOfBirth: e.placeOfBirth ?? null,
        nationalities: JSON.stringify(e.nationalities),
        idNumbers: JSON.stringify(e.idNumbers),
        addresses: JSON.stringify(e.addresses),
        riskCategory: e.riskCategory,
        programs: JSON.stringify(e.programs),
        rawData: JSON.stringify(e.rawData),
        createdAt: now,
      });
    }
  });

  runAll(entities);

  db.prepare(
    `INSERT INTO audit_log (id, entity_type, entity_id, action, actor, details, created_at)
     VALUES (@id, 'import', @entityId, 'imported', 'ingestion-scheduler', @details, @createdAt)`
  ).run({
    id: uuid(),
    entityId: listVersionId,
    details: JSON.stringify({ source, recordCount: entities.length, checksum }),
    createdAt: now,
  });

  return { source, listVersionId, recordCount: entities.length };
}
