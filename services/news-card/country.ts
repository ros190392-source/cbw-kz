/**
 * Country detection for news cards (EPIC 021 art).
 *
 * Maps country mentions in a news title/summary to an ISO 3166-1 alpha-2 code
 * so the card can show the country's flag. Deterministic keyword matching —
 * conservative by design: when no country is clearly mentioned, returns null
 * and the card stays purely global.
 */

export interface DetectedCountry {
  iso: string;   // lowercase alpha-2, matches flag-icons filenames
  name: string;  // display name
}

interface CountryDef extends DetectedCountry {
  /** Lowercase keywords; word-ish boundaries are handled by the matcher. */
  keywords: string[];
}

/** Ordered: more specific entries first (e.g. "hong kong" before "china"). */
const COUNTRIES: CountryDef[] = [
  { iso: 'hk', name: 'Hong Kong',      keywords: ['hong kong'] },
  { iso: 'us', name: 'United States',  keywords: ['united states', 'u.s.', ' us ', 'usa', 'america', 'sec ', 'cftc', 'federal reserve', 'white house', 'congress', 'senate', 'wall street', 'new york', 'texas', 'california'] },
  { iso: 'eu', name: 'European Union', keywords: ['european union', ' eu ', 'mica', 'european commission', 'eurozone', 'ecb'] },
  { iso: 'gb', name: 'United Kingdom', keywords: ['united kingdom', ' uk ', 'britain', 'british', 'london', 'fca '] },
  { iso: 'cn', name: 'China',          keywords: ['china', 'chinese', 'beijing', 'shanghai'] },
  { iso: 'jp', name: 'Japan',          keywords: ['japan', 'japanese', 'tokyo'] },
  { iso: 'kr', name: 'South Korea',    keywords: ['south korea', 'korean', 'seoul'] },
  { iso: 'sg', name: 'Singapore',      keywords: ['singapore'] },
  { iso: 'ae', name: 'UAE',            keywords: ['united arab emirates', ' uae ', 'dubai', 'abu dhabi'] },
  { iso: 'ru', name: 'Russia',         keywords: ['russia', 'russian', 'moscow'] },
  { iso: 'de', name: 'Germany',        keywords: ['germany', 'german', 'berlin', 'bafin'] },
  { iso: 'fr', name: 'France',         keywords: ['france', 'french', 'paris'] },
  { iso: 'ch', name: 'Switzerland',    keywords: ['switzerland', 'swiss', 'zug', 'zurich'] },
  { iso: 'in', name: 'India',          keywords: ['india', 'indian', 'mumbai', 'new delhi'] },
  { iso: 'br', name: 'Brazil',         keywords: ['brazil', 'brazilian'] },
  { iso: 'ar', name: 'Argentina',      keywords: ['argentina', 'argentine'] },
  { iso: 'tr', name: 'Turkey',         keywords: ['turkey', 'turkish', 'istanbul'] },
  { iso: 'kz', name: 'Kazakhstan',     keywords: ['kazakhstan', 'astana', 'almaty', 'tenge'] },
  { iso: 'ng', name: 'Nigeria',        keywords: ['nigeria', 'nigerian'] },
  { iso: 'sv', name: 'El Salvador',    keywords: ['el salvador', 'salvadoran', 'bukele'] },
  { iso: 'ca', name: 'Canada',         keywords: ['canada', 'canadian', 'toronto', 'ontario'] },
  { iso: 'au', name: 'Australia',      keywords: ['australia', 'australian'] },
  { iso: 'nl', name: 'Netherlands',    keywords: ['netherlands', 'dutch', 'amsterdam'] },
  { iso: 'ua', name: 'Ukraine',        keywords: ['ukraine', 'ukrainian', 'kyiv'] },
  { iso: 'il', name: 'Israel',         keywords: ['israel', 'israeli', 'tel aviv'] },
  { iso: 'sa', name: 'Saudi Arabia',   keywords: ['saudi arabia', 'saudi', 'riyadh'] },
  { iso: 'id', name: 'Indonesia',      keywords: ['indonesia', 'indonesian', 'jakarta'] },
  { iso: 'vn', name: 'Vietnam',        keywords: ['vietnam', 'vietnamese', 'hanoi'] },
  { iso: 'th', name: 'Thailand',       keywords: ['thailand', 'thai ', 'bangkok'] },
  { iso: 'ph', name: 'Philippines',    keywords: ['philippines', 'filipino', 'manila'] },
  { iso: 'mx', name: 'Mexico',         keywords: ['mexico', 'mexican'] },
  { iso: 'za', name: 'South Africa',   keywords: ['south africa', 'south african'] },
];

/**
 * Detect the most prominent country in the text. Pads the text with spaces so
 * boundary keywords like " us " match at the string edges too; counts keyword
 * hits and returns the country with the most (ties → earlier in the list).
 */
export function detectCountry(text: string): DetectedCountry | null {
  const t = ` ${(text ?? '').toLowerCase().replace(/[\n\t]/g, ' ')} `;
  let best: { def: CountryDef; hits: number } | null = null;
  for (const def of COUNTRIES) {
    let hits = 0;
    for (const kw of def.keywords) {
      if (t.includes(kw)) hits++;
    }
    if (hits > 0 && (!best || hits > best.hits)) best = { def, hits };
  }
  return best ? { iso: best.def.iso, name: best.def.name } : null;
}
