/**
 * Market category classifier.
 *
 * Polymarket's public /trades API returns `category: null` for ~98% of trades
 * (verified live 2026-07-14: 907 of 928 stored categories were null), so we
 * cannot rely on the stored field to filter. Instead we DERIVE the category
 * from the market question text with keyword heuristics. It is a best-effort
 * label — honest, not authoritative — used only to power the UI category
 * filter. Pure + deterministic so it is testable and can run client-side.
 */

export type CategoryKey =
  | "deportes"
  | "esports"
  | "cripto"
  | "economia"
  | "politica"
  | "clima"
  | "cultura"
  | "otros";

export const CATEGORY_LABELS: Record<CategoryKey, string> = {
  deportes: "⚽ Deportes",
  esports: "🎮 Esports",
  cripto: "₿ Cripto",
  economia: "💵 Economía",
  politica: "🏛️ Política",
  clima: "🌦️ Clima",
  cultura: "🎬 Cultura",
  otros: "❓ Otros",
};

// Order matters: the first matcher that hits wins. Esports is checked before
// Deportes (esports markets also say "vs"); crypto before economia (a "$" alone
// is ambiguous). Each entry is a list of case-insensitive substrings/patterns.
const MATCHERS: { key: CategoryKey; patterns: RegExp[] }[] = [
  {
    key: "esports",
    patterns: [
      /\b(dota|dota 2|lol|league of legends|cs2|cs:go|counter-strike|valorant|overwatch|rocket league|starcraft|esports?|e-sports?)\b/i,
      /\bbo[135]\b/i, // best-of-N series
      /\b(prime league|esports world cup|the international|blast|iem|major)\b/i,
    ],
  },
  {
    key: "cripto",
    patterns: [
      /\b(bitcoin|btc|ethereum|eth|solana|\bsol\b|dogecoin|doge|ripple|xrp|cardano|crypto|token|blockchain|stablecoin|altcoin|memecoin|nft)\b/i,
      /\b(up or down)\b/i, // "Bitcoin Up or Down - ..." fast markets
      /\$\d[\d,.]*k?\b.*\b(close|flip|hit|reach|above|below)\b/i, // "close above $120k"
    ],
  },
  {
    key: "clima",
    patterns: [/\b(temperature|hurricane|tornado|rainfall|snowfall|weather|heatwave|storm|degrees|°[cf]|celsius|fahrenheit|el niño|la niña)\b/i],
  },
  {
    key: "economia",
    patterns: [
      /\b(fed|federal reserve|rate cut|rate hike|interest rate|rates?|inflation|cpi|ppi|gdp|recession|jobs report|unemployment|s&p 500|s&p500|nasdaq|dow jones|stock|shares?|ipo|earnings|treasury|bond yields?|jerome powell|ecb)\b/i,
    ],
  },
  {
    key: "politica",
    patterns: [
      /\b(election|president|presidential|senate|congress|parliament|prime minister|governor|mayor|vote|votes|ballot|referendum|poll|resign|impeach|cabinet|nominee|primary|caucus)\b/i,
      /\b(war|ceasefire|sanction|treaty|negotiations?|withdrawal|invasion|nato|united nations|\bun\b|geopolit|coup|border|nuclear deal|mou)\b/i,
      /\b(trump|biden|putin|zelensky|netanyahu|xi jinping|iran|israel|ukraine|russia|china|north korea|venezuela)\b/i,
    ],
  },
  {
    key: "cultura",
    patterns: [
      /\b(oscar|oscars|grammy|emmy|golden globe|box office|billboard|album|movie|film|celebrity|tv show|netflix|spotify|rotten tomatoes|awards?)\b/i,
    ],
  },
  {
    key: "deportes",
    patterns: [
      /\bvs\.?\b/i, // "Team A vs. Team B" — the dominant sports shape
      /\b(open|masters|cup|spread|final|semifinal|quarterfinal|round)\s*:/i, // "Athens Open:", "Spread:"
      /\b(o\/u|over\/under|advances?|golden boot|ballon d'or|world series|world cup|finals?|playoffs?|match winner|to advance|to win|moneyline|handicap)\b/i,
      /\b(nba|wnba|mlb|nfl|nhl|mls|ufc|f1|formula 1|premier league|la liga|serie a|bundesliga|champions league|wimbledon|roland garros|atp|wta|pga)\b/i,
      /\b(fc|cf|united|city|rovers|athletic)\b.*\bwin\b/i, // "Will Chicago Fire FC win on ..."
    ],
  },
];

/**
 * Classify a market question into a coarse category. A combo (parlay) title
 * joins several legs with " AND " — it inherits the category of its FIRST leg,
 * which in practice is what the whole parlay is about (all-sports, all-crypto…).
 */
export function categorizeMarket(question: string | null | undefined): CategoryKey {
  if (!question) return "otros";
  const q = question.split(" AND ")[0]; // first leg for combos
  for (const { key, patterns } of MATCHERS) {
    if (patterns.some((re) => re.test(q))) return key;
  }
  return "otros";
}
