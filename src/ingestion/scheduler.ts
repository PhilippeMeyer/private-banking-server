import cron from "node-cron";
import { config } from "../config";
import { importOfacSdn, importOfacConsolidated } from "./ofac";
import { importUn } from "./un";
import { importEu } from "./eu";
import { importUk } from "./uk";
import { importJpMof } from "./jpMof";
import { importOpenSanctions } from "./openSanctions";
import { importOpenSanctionsPep } from "./openSanctionsPep";
import { importPep, importAdverseMedia } from "./vendorFeed";
import { ImportResult } from "./types";

type ImportJob = { name: string; run: () => Promise<ImportResult> };

const jobs: ImportJob[] = [
  { name: "OFAC_SDN", run: importOfacSdn },
  { name: "OFAC_CONSOLIDATED", run: importOfacConsolidated },
  { name: "UN", run: importUn },
  { name: "EU", run: importEu },
  { name: "UK", run: importUk },
  { name: "JP_MOF", run: importJpMof },
  { name: "OPENSANCTIONS_CSV", run: importOpenSanctions },
  { name: "OPENSANCTIONS_PEP", run: importOpenSanctionsPep },
  { name: "PEP", run: importPep },
  { name: "ADVERSE_MEDIA", run: importAdverseMedia },
];

async function runJob(job: ImportJob): Promise<void> {
  const started = Date.now();
  console.log(`[import] starting ${job.name}`);
  try {
    const result = await job.run();
    console.log(
      `[import] ${job.name} complete: ${result.recordCount} records in ${Date.now() - started}ms`
    );
  } catch (err) {
    // Deliberately does not throw further: one source failing (e.g. a vendor
    // outage) should never block the other sources' scheduled imports.
    console.error(`[import] ${job.name} FAILED:`, err instanceof Error ? err.message : err);
  }
}

function findJob(name: string): ImportJob {
  const job = jobs.find((j) => j.name === name);
  if (!job) throw new Error(`No import job registered with name "${name}"`);
  return job;
}

/**
 * Registers all cron jobs. Each source gets its own schedule (see .env) since
 * sources update at different cadences (OFAC/UN/EU/UK roughly daily, a
 * licensed PEP/adverse-media feed potentially differently, OpenSanctions
 * daily but lower priority given its licensing gate).
 */
export function startScheduler(): void {
  cron.schedule(config.cron.ofac, () => {
    runJob(findJob("OFAC_SDN"));
    runJob(findJob("OFAC_CONSOLIDATED"));
  });
  cron.schedule(config.cron.un, () => runJob(findJob("UN")));
  cron.schedule(config.cron.eu, () => runJob(findJob("EU")));
  cron.schedule(config.cron.uk, () => runJob(findJob("UK")));
  cron.schedule(config.cron.jpMof, () => runJob(findJob("JP_MOF")));
  cron.schedule(config.cron.openSanctions, () => runJob(findJob("OPENSANCTIONS_PEP")));
  cron.schedule(config.cron.pep, () => runJob(findJob("PEP")));
  cron.schedule(config.cron.adverseMedia, () => runJob(findJob("ADVERSE_MEDIA")));

  console.log("[scheduler] all import jobs registered:");
  console.log(`  OFAC (SDN + Consolidated): ${config.cron.ofac}`);
  console.log(`  UN:                        ${config.cron.un}`);
  console.log(`  EU:                        ${config.cron.eu}`);
  console.log(`  UK:                        ${config.cron.uk}`);
  console.log(`  Japan MOF:                 ${config.cron.jpMof}`);
  console.log(`  OpenSanctions (PEP):       ${config.cron.openSanctions} (requires license confirmation)`);
  console.log(`  PEP vendor:                ${config.cron.pep}`);
  console.log(`  Adverse media vendor:      ${config.cron.adverseMedia}`);
}

// Allows `npm run import:now` to trigger every import immediately, useful for
// local testing or a manual re-run without waiting for the cron schedule.
// Supports --only=NAME1,NAME2 to re-run just specific source(s) — e.g. after
// fixing one source's config/parser, there's no need to redo every other
// source too. Job names match the `name` field in the jobs array above
// (OFAC_SDN, OFAC_CONSOLIDATED, UN, EU, UK, JP_MOF, OPENSANCTIONS_CSV,
// OPENSANCTIONS_PEP, PEP, ADVERSE_MEDIA).
if (require.main === module && process.argv.includes("--run-once")) {
  const onlyArg = process.argv.find((a) => a.startsWith("--only="));
  const onlyNames = onlyArg ? onlyArg.slice("--only=".length).split(",").map((s) => s.trim()) : null;

  const jobsToRun = onlyNames
    ? jobs.filter((j) => onlyNames.includes(j.name))
    : jobs;

  if (onlyNames) {
    const unknownNames = onlyNames.filter((n) => !jobs.some((j) => j.name === n));
    if (unknownNames.length > 0) {
      console.error(
        `Unknown job name(s): ${unknownNames.join(", ")}. Valid names: ${jobs.map((j) => j.name).join(", ")}`
      );
      process.exit(1);
    }
  }

  (async () => {
    for (const job of jobsToRun) {
      await runJob(job);
    }
    process.exit(0);
  })();
}
