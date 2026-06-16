import type {
  AlertSeverity,
  AlertType,
  EventType,
  Platform,
  TradeSide,
  WhaleTier,
} from './constants.js';

/**
 * Normalized domain model. Collectors emit raw venue payloads; the normalizer
 * maps them onto these shapes before anything else touches the data.
 *
 * Prices are always expressed as an implied probability in [0, 1] for binary
 * outcomes so that cross-platform comparison is apples-to-apples. `size` and
 * `sizeUsd` are notional, not shares.
 */

export interface NormalizedMarket {
  platform: Platform;
  /** Venue-native id (token/condition/market id). Unique per platform. */
  externalId: string;
  title: string;
  eventType: EventType;
  /** Canonical team/competitor this market resolves on, when applicable. */
  team?: string | null;
  /** ISO matchup / event identifier so cross-platform markets can be linked. */
  canonicalKey?: string | null;
  startTime?: Date | null;
  closeTime?: Date | null;
  status: 'open' | 'closed' | 'resolved' | 'unknown';
  /** Cumulative traded volume in USD (or play-$ for Manifold). */
  volumeUsd?: number | null;
  liquidityUsd?: number | null;
  /** The set of outcomes/runners with current implied probabilities. */
  outcomes?: NormalizedOutcome[];
  raw?: unknown;
}

export interface NormalizedOutcome {
  /** e.g. "Yes" / "No" / "Brazil". */
  name: string;
  externalId?: string | null;
  impliedProb?: number | null;
  lastPrice?: number | null;
}

export interface NormalizedTrade {
  platform: Platform;
  externalId: string;
  marketExternalId: string;
  outcomeName?: string | null;
  /** Stable wallet/user id where available; null for odds-only venues. */
  wallet?: string | null;
  /** Human-readable trader display name where the venue exposes one. */
  trader?: string | null;
  side: TradeSide;
  /** Implied probability in [0,1] at which the trade executed. */
  price: number;
  /** Notional size in shares/contracts. */
  size: number;
  /** Notional size in USD (size * price * unit, venue-dependent). */
  sizeUsd: number;
  timestamp: Date;
  raw?: unknown;
}

export interface NormalizedOrderBook {
  platform: Platform;
  marketExternalId: string;
  outcomeName?: string | null;
  bestBid: number | null;
  bestAsk: number | null;
  spread: number | null;
  /** Sum of resting notional within a configurable band, in USD. */
  bidDepthUsd: number | null;
  askDepthUsd: number | null;
  liquidityUsd: number | null;
  timestamp: Date;
  raw?: unknown;
}

export interface WhaleSignal {
  tradeExternalId: string;
  platform: Platform;
  marketExternalId: string;
  wallet?: string | null;
  sizeUsd: number;
  side: TradeSide;
  price: number;
  /** 0–100 composite whale score. */
  score: number;
  tier: WhaleTier;
  components: WhaleScoreComponents;
  /** % price move attributable to the trade, if measurable. */
  marketImpactPct?: number | null;
  timestamp: Date;
}

export interface WhaleScoreComponents {
  positionSize: number;
  historicalRoi: number;
  marketImpact: number;
  timing: number;
}

export interface WalletPerformance {
  wallet: string;
  platform: Platform;
  trades: number;
  resolvedPositions: number;
  totalStakedUsd: number;
  realizedPnlUsd: number;
  roi: number;
  winRate: number;
  avgPositionUsd: number;
  expectedValue: number;
  sharpe: number;
}

export interface ArbitrageOpportunity {
  canonicalKey: string;
  outcomeName: string;
  legs: Array<{
    platform: Platform;
    marketExternalId: string;
    impliedProb: number;
    bestPrice: number;
  }>;
  /** Theoretical edge after configured fees, e.g. 0.04 = 4%. */
  edge: number;
  /** Sum of inverse prices; <1 implies a riskless arb on binary markets. */
  bookSum: number;
  detectedAt: Date;
}

export interface SteamSignal {
  platform: Platform;
  marketExternalId: string;
  outcomeName?: string | null;
  fromProb: number;
  toProb: number;
  movePct: number;
  windowMs: number;
  /** True when no single qualifying whale trade explains the move. */
  noVisibleWhale: boolean;
  detectedAt: Date;
}

export interface AlertPayload {
  type: AlertType;
  severity: AlertSeverity;
  platform: Platform;
  title: string;
  body: string;
  /** Structured fields for the dashboard / API consumers. */
  data: Record<string, unknown>;
  dedupeKey: string;
  createdAt: Date;
}
