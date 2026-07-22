import { MatchResult, RiskBand } from "../normalize/entity";

// Illustrative starter list — maintain this against the current FATF
// high-risk/monitored jurisdictions list, which is updated a few times a year.
export const HIGH_RISK_JURISDICTIONS = new Set([
  "IR", "KP", "MM", // FATF "call for action" (illustrative, verify current list)
]);
export const MONITORED_JURISDICTIONS = new Set([
  "SY", "YE", "SS", // FATF "increased monitoring" (illustrative, verify current list)
]);

export interface ScoringInput {
  matches: MatchResult[];
  subjectNationality?: string;
  sourceOfFundsRisk?: "low" | "medium" | "high"; // supplied by onboarding flow, if known
  isPepAssociate?: boolean; // family member / close associate of a PEP, not the PEP themself
}

export interface ScoringOutput {
  riskScore: number; // 0..1
  riskBand: RiskBand;
  factors: string[]; // human-readable list of what drove the score, for audit
}

/**
 * Combines list-match confidence with contextual risk factors into one score.
 * Deliberately conservative: a single high-confidence sanctions hit should
 * always land in "high", regardless of other factors softening the picture.
 */
export function scoreRisk(input: ScoringInput): ScoringOutput {
  const factors: string[] = [];

  const sanctionsHits = input.matches.filter((m) => m.riskCategory === "sanctions");
  const pepHits = input.matches.filter((m) => m.riskCategory === "pep");
  const adverseMediaHits = input.matches.filter((m) => m.riskCategory === "adverse_media");
  const customHits = input.matches.filter((m) => m.riskCategory === "custom");

  const bestSanctionsScore = Math.max(0, ...sanctionsHits.map((m) => m.score));
  const bestPepScore = Math.max(0, ...pepHits.map((m) => m.score));
  const bestAdverseMediaScore = Math.max(0, ...adverseMediaHits.map((m) => m.score));
  const bestCustomScore = Math.max(0, ...customHits.map((m) => m.score));

  // Any high-confidence sanctions hit is an automatic "high", full stop.
  if (bestSanctionsScore >= 0.82) {
    factors.push(`High-confidence sanctions list match (${bestSanctionsScore.toFixed(2)})`);
    return { riskScore: Math.max(0.95, bestSanctionsScore), riskBand: "high", factors };
  }

  // Each category's weight reflects how seriously a strong hit in that
  // category should be taken on its own (a confirmed custom-list hit is not
  // "10% as bad" as a sanctions hit — it's a real, if lower-severity, flag).
  // Take the weighted max across categories as the base, then let secondary
  // categories add a smaller top-up so multiple simultaneous hits still push
  // the score higher than any single one alone.
  const weighted = [
    { value: bestSanctionsScore * 0.9, hits: sanctionsHits.length, label: "Sanctions", raw: bestSanctionsScore },
    { value: bestPepScore * 0.75, hits: pepHits.length, label: "PEP", raw: bestPepScore },
    { value: bestCustomScore * 0.65, hits: customHits.length, label: "Custom list", raw: bestCustomScore },
    { value: bestAdverseMediaScore * 0.5, hits: adverseMediaHits.length, label: "Adverse media", raw: bestAdverseMediaScore },
  ].filter((w) => w.hits > 0);

  weighted.sort((a, b) => b.value - a.value);

  let score = 0;
  if (weighted.length > 0) {
    score = weighted[0].value;
    factors.push(`${weighted[0].label} candidate match(es): best ${weighted[0].raw.toFixed(2)}`);

    // Secondary categories contribute a diminishing top-up rather than full weight.
    for (const w of weighted.slice(1)) {
      score += w.value * 0.2;
      factors.push(`${w.label} candidate match(es): best ${w.raw.toFixed(2)}`);
    }
  }

  if (input.subjectNationality) {
    const code = input.subjectNationality.toUpperCase();
    if (HIGH_RISK_JURISDICTIONS.has(code)) {
      score += 0.2;
      factors.push(`Nationality ${code} is on the high-risk jurisdiction list`);
    } else if (MONITORED_JURISDICTIONS.has(code)) {
      score += 0.1;
      factors.push(`Nationality ${code} is on the increased-monitoring list`);
    }
  }

  if (input.sourceOfFundsRisk === "high") {
    score += 0.15;
    factors.push("Source of funds flagged high risk by onboarding");
  } else if (input.sourceOfFundsRisk === "medium") {
    score += 0.07;
    factors.push("Source of funds flagged medium risk by onboarding");
  }

  if (input.isPepAssociate) {
    score += 0.1;
    factors.push("Subject is a known associate/family member of a PEP");
  }

  score = Math.min(1, score);

  const riskBand: RiskBand = score >= 0.6 ? "high" : score >= 0.3 ? "medium" : "low";

  if (factors.length === 0) factors.push("No list matches or elevated risk factors found");

  return { riskScore: score, riskBand, factors };
}
