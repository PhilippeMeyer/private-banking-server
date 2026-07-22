/**
 * Name-matching primitives. Kept dependency-free and explicit so the scoring
 * logic is auditable — regulators and internal audit will want to know
 * exactly how a match score was derived.
 */

export function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // strip diacritics (é -> e, etc.)
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function levenshteinDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[m][n];
}

export function levenshteinSimilarity(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - levenshteinDistance(a, b) / maxLen;
}

/** Jaro similarity, the base for Jaro-Winkler. Rewards matching prefixes,
 * which suits names (transliteration differences usually show up mid/end). */
export function jaroSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  const aLen = a.length;
  const bLen = b.length;
  if (aLen === 0 || bLen === 0) return 0;

  const matchWindow = Math.max(0, Math.floor(Math.max(aLen, bLen) / 2) - 1);
  const aMatches = new Array(aLen).fill(false);
  const bMatches = new Array(bLen).fill(false);

  let matches = 0;
  for (let i = 0; i < aLen; i++) {
    const start = Math.max(0, i - matchWindow);
    const end = Math.min(i + matchWindow + 1, bLen);
    for (let j = start; j < end; j++) {
      if (bMatches[j] || a[i] !== b[j]) continue;
      aMatches[i] = true;
      bMatches[j] = true;
      matches++;
      break;
    }
  }
  if (matches === 0) return 0;

  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < aLen; i++) {
    if (!aMatches[i]) continue;
    while (!bMatches[k]) k++;
    if (a[i] !== b[k]) transpositions++;
    k++;
  }

  return (
    (matches / aLen + matches / bLen + (matches - transpositions / 2) / matches) / 3
  );
}

export function jaroWinklerSimilarity(a: string, b: string, prefixScale = 0.1): number {
  const jaro = jaroSimilarity(a, b);
  let prefixLen = 0;
  const maxPrefix = 4;
  for (let i = 0; i < Math.min(maxPrefix, a.length, b.length); i++) {
    if (a[i] === b[i]) prefixLen++;
    else break;
  }
  return jaro + prefixLen * prefixScale * (1 - jaro);
}

// Common name "particles" across many languages/cultures (articles,
// prepositions, patronymic markers) that are near-meaningless for matching
// on their own. Without this, a query like "Le Pen" can score deceptively
// high against completely unrelated names like "Le Général" or "Le Grand"
// purely because they share the token "le" — while the real target
// ("Marine LE PEN") can score *lower*, since Jaro-Winkler rewards matching
// prefixes and "marine" vs "le" as a first token is a worse prefix match
// than "le" vs "le". Down-weighting particles in token overlap fixes this
// without a brittle exact-match veto that could reject legitimate
// single-token typo matches (e.g. a surname-only query with a typo).
const NAME_PARTICLES = new Set([
  "le", "la", "les", "de", "du", "des", "van", "von", "der", "den", "het",
  "bin", "ibn", "al", "el", "mc", "mac", "o", "da", "do", "dos", "das",
  "san", "santa", "di", "af", "ter", "ten", "zu", "zur",
]);
const PARTICLE_WEIGHT = 0.15;

function tokenWeight(token: string): number {
  return NAME_PARTICLES.has(token) ? PARTICLE_WEIGHT : 1;
}

/** Token-set overlap catches reordered names ("Smith John" vs "John Smith")
 * and partial name matches that character-level distance handles poorly.
 * Weighted so common particles ("le", "de", "van"...) count for much less
 * than substantive tokens — otherwise a query like "Le Pen" would score
 * deceptively high against any name merely starting with "Le ...".
 *
 * Uses a containment coefficient (shared weight / min of the two sides'
 * total weight), not Jaccard (shared / union): KYC screening routinely
 * uses partial queries (surname only, no given name), and a symmetric
 * union-based measure unfairly penalizes a short deliberate partial query
 * against a longer full-name record that legitimately contains it.
 */
export function tokenOverlapScore(a: string, b: string): number {
  const aTokens = a.split(" ").filter(Boolean);
  const bTokens = b.split(" ").filter(Boolean);
  if (aTokens.length === 0 || bTokens.length === 0) return 0;

  const aSet = new Set(aTokens);
  const bSet = new Set(bTokens);

  const sumWeight = (tokens: string[]) => tokens.reduce((sum, t) => sum + tokenWeight(t), 0);
  const aWeight = sumWeight(aTokens);
  const bWeight = sumWeight(bTokens);

  let sharedWeight = 0;
  for (const t of aSet) {
    if (bSet.has(t)) sharedWeight += tokenWeight(t);
  }

  const denom = Math.min(aWeight, bWeight);
  return denom === 0 ? 0 : sharedWeight / denom;
}

function stripParticles(normalized: string): string {
  const substantive = normalized.split(" ").filter((t) => t && !NAME_PARTICLES.has(t));
  // If a name is nothing but particles (rare edge case), fall back to the
  // original rather than comparing empty strings.
  return substantive.length > 0 ? substantive.join(" ") : normalized;
}

/**
 * Combined name-similarity score, 0..1. Blends Jaro-Winkler (good for typos/
 * transliteration) with token overlap (good for reordering/partial names).
 * Every screening result should carry this breakdown so an analyst reviewing
 * a hit can see *why* it matched, not just a bare number.
 *
 * Jaro-Winkler and Levenshtein run on particle-stripped strings, not the raw
 * normalized name: JW's prefix bonus otherwise lets a shared leading
 * particle ("le", "de", "van"...) inflate similarity between names that
 * share nothing else meaningful — e.g. "Le Pen" vs "Le Général" scoring
 * deceptively high purely because both start with "le ".
 */
export function nameSimilarity(
  candidateName: string,
  targetName: string
): { score: number; jaroWinkler: number; levenshtein: number; tokenOverlap: number } {
  const a = normalizeName(candidateName);
  const b = normalizeName(targetName);

  const aCore = stripParticles(a);
  const bCore = stripParticles(b);

  const jw = jaroWinklerSimilarity(aCore, bCore);
  const lev = levenshteinSimilarity(aCore, bCore);
  const tok = tokenOverlapScore(a, b); // full tokens — particles are down-weighted, not removed, here

  // Weighted blend: token overlap now carries the most weight since,
  // post particle-weighting and the containment coefficient above, it's
  // the most reliable single signal — especially for partial-name queries
  // (surname only) where Jaro-Winkler's character-level comparison is
  // inherently weak (the strings are just different lengths). Jaro-Winkler
  // still matters for typo/transliteration detection; Levenshtein remains
  // a sanity-check floor.
  const score = jw * 0.35 + tok * 0.5 + lev * 0.15;

  return { score, jaroWinkler: jw, levenshtein: lev, tokenOverlap: tok };
}
