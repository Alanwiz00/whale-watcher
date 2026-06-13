/**
 * Platform identifiers. Keep these stable — they are persisted in the DB and
 * referenced across collectors, the engine, and the API.
 */
export const PLATFORMS = [
  'polymarket',
  'kalshi',
  'manifold',
  'predictit',
  'betfair',
  'pinnacle',
  'stake',
  'draftkings',
  'fanduel',
] as const;

export type Platform = (typeof PLATFORMS)[number];

/** Venues where we can attribute trades to a stable wallet/user id. */
export const WALLET_NATIVE_PLATFORMS: Platform[] = ['polymarket', 'kalshi', 'manifold'];

/** Venues we treat as odds-only price feeds (no identifiable bettors). */
export const ODDS_ONLY_PLATFORMS: Platform[] = [
  'betfair',
  'pinnacle',
  'stake',
  'draftkings',
  'fanduel',
];

export const EVENT_TYPES = [
  'tournament_winner',
  'reach_stage',
  'golden_boot',
  'group_winner',
  'match_result',
  'match_total_goals',
  'tournament_total_goals',
  'top_scorer_team',
  'other',
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export const TRADE_SIDES = ['buy', 'sell'] as const;
export type TradeSide = (typeof TRADE_SIDES)[number];

/**
 * Discovery keyword sets used to identify FIFA World Cup 2026 markets across
 * heterogeneous venue titles. Tuned to be high-recall; the normalizer applies
 * stricter event-type classification afterwards.
 */
export const WORLD_CUP_KEYWORDS = [
  'world cup 2026',
  'fifa world cup',
  'wc 2026',
  '2026 world cup',
  'world cup',
] as const;

/** Strong national-team / context signals to disambiguate "world cup". */
export const WC_2026_CONTEXT_TERMS = [
  '2026',
  'fifa',
  'golden boot',
  'group stage',
  'knockout',
  'quarterfinal',
  'semifinal',
  'final',
  'usa canada mexico',
] as const;

export const COUNTRY_ALIASES: Record<string, string[]> = {
  brazil: ['brazil', 'brasil', 'bra', 'seleção'],
  argentina: ['argentina', 'arg', 'albiceleste'],
  france: ['france', 'fra', 'les bleus'],
  england: ['england', 'eng', 'three lions'],
  spain: ['spain', 'esp', 'la roja'],
  germany: ['germany', 'ger', 'die mannschaft'],
  portugal: ['portugal', 'por'],
  netherlands: ['netherlands', 'holland', 'ned', 'oranje'],
  usa: ['usa', 'united states', 'usmnt', 'u.s.a.'],
};

/** Whale classification tiers by 0–100 whale score. Order matters (desc). */
export const WHALE_TIERS = [
  { min: 90, label: 'Elite Whale', emoji: '🐋' },
  { min: 75, label: 'Strong Whale', emoji: '🦈' },
  { min: 50, label: 'Notable Whale', emoji: '🐬' },
  { min: 0, label: 'Normal', emoji: '🐟' },
] as const;

export type WhaleTier = (typeof WHALE_TIERS)[number]['label'];

export const ALERT_TYPES = [
  'whale_trade',
  'split_accumulation',
  'smart_money',
  'steam_move',
  'market_impact',
  'arbitrage',
  'volume_anomaly',
  'wallet_anomaly',
] as const;

export type AlertType = (typeof ALERT_TYPES)[number];

export const ALERT_SEVERITY = ['low', 'medium', 'high', 'critical'] as const;
export type AlertSeverity = (typeof ALERT_SEVERITY)[number];
