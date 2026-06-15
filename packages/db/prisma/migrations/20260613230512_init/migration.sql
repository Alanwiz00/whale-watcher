-- CreateEnum
CREATE TYPE "Platform" AS ENUM ('polymarket', 'kalshi', 'manifold', 'predictit', 'betfair', 'pinnacle', 'stake', 'draftkings', 'fanduel');

-- CreateEnum
CREATE TYPE "EventType" AS ENUM ('tournament_winner', 'reach_stage', 'golden_boot', 'group_winner', 'match_result', 'match_total_goals', 'tournament_total_goals', 'top_scorer_team', 'other');

-- CreateEnum
CREATE TYPE "MarketStatus" AS ENUM ('open', 'closed', 'resolved', 'unknown');

-- CreateEnum
CREATE TYPE "TradeSide" AS ENUM ('buy', 'sell');

-- CreateEnum
CREATE TYPE "AlertType" AS ENUM ('whale_trade', 'split_accumulation', 'smart_money', 'steam_move', 'market_impact', 'arbitrage', 'volume_anomaly', 'wallet_anomaly');

-- CreateEnum
CREATE TYPE "AlertSeverity" AS ENUM ('low', 'medium', 'high', 'critical');

-- CreateEnum
CREATE TYPE "WhaleTier" AS ENUM ('elite', 'strong', 'notable', 'normal');

-- CreateTable
CREATE TABLE "markets" (
    "id" TEXT NOT NULL,
    "platform" "Platform" NOT NULL,
    "externalId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "eventType" "EventType" NOT NULL DEFAULT 'other',
    "team" TEXT,
    "canonicalKey" TEXT,
    "startTime" TIMESTAMP(3),
    "closeTime" TIMESTAMP(3),
    "status" "MarketStatus" NOT NULL DEFAULT 'unknown',
    "volumeUsd" DECIMAL(20,4),
    "liquidityUsd" DECIMAL(20,4),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "markets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wallets" (
    "id" TEXT NOT NULL,
    "platform" "Platform" NOT NULL,
    "address" TEXT NOT NULL,
    "label" TEXT,
    "firstSeen" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeen" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wallets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wallet_stats" (
    "id" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "trades" INTEGER NOT NULL DEFAULT 0,
    "resolvedPositions" INTEGER NOT NULL DEFAULT 0,
    "totalStakedUsd" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "realizedPnlUsd" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "roi" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "winRate" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "avgPositionUsd" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "expectedValue" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "sharpe" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "whaleScoreAvg" DOUBLE PRECISION,
    "rankRoi" INTEGER,
    "rankVolume" INTEGER,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wallet_stats_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trades" (
    "id" TEXT NOT NULL,
    "platform" "Platform" NOT NULL,
    "externalId" TEXT NOT NULL,
    "marketId" TEXT NOT NULL,
    "outcomeName" TEXT,
    "walletId" TEXT,
    "walletAddress" TEXT,
    "side" "TradeSide" NOT NULL,
    "price" DECIMAL(10,6) NOT NULL,
    "size" DECIMAL(24,6) NOT NULL,
    "sizeUsd" DECIMAL(20,4) NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "raw" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trades_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_books" (
    "id" TEXT NOT NULL,
    "platform" "Platform" NOT NULL,
    "marketId" TEXT NOT NULL,
    "outcomeName" TEXT,
    "bestBid" DECIMAL(10,6),
    "bestAsk" DECIMAL(10,6),
    "spread" DECIMAL(10,6),
    "bidDepthUsd" DECIMAL(20,4),
    "askDepthUsd" DECIMAL(20,4),
    "liquidityUsd" DECIMAL(20,4),
    "timestamp" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_books_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "market_snapshots" (
    "id" TEXT NOT NULL,
    "marketId" TEXT NOT NULL,
    "outcomeName" TEXT,
    "impliedProb" DECIMAL(10,6),
    "volumeUsd" DECIMAL(20,4),
    "liquidityUsd" DECIMAL(20,4),
    "timestamp" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "market_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "whale_signals" (
    "id" TEXT NOT NULL,
    "tradeId" TEXT,
    "platform" "Platform" NOT NULL,
    "marketId" TEXT NOT NULL,
    "walletId" TEXT,
    "sizeUsd" DECIMAL(20,4) NOT NULL,
    "side" "TradeSide" NOT NULL,
    "price" DECIMAL(10,6) NOT NULL,
    "score" INTEGER NOT NULL,
    "tier" "WhaleTier" NOT NULL,
    "componentSize" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "componentRoi" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "componentImpact" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "componentTiming" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "marketImpactPct" DOUBLE PRECISION,
    "isSplitAggregate" BOOLEAN NOT NULL DEFAULT false,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "whale_signals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alerts" (
    "id" TEXT NOT NULL,
    "type" "AlertType" NOT NULL,
    "severity" "AlertSeverity" NOT NULL,
    "platform" "Platform" NOT NULL,
    "marketId" TEXT,
    "walletId" TEXT,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "delivered" BOOLEAN NOT NULL DEFAULT false,
    "deliveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "alerts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "arbitrage_events" (
    "id" TEXT NOT NULL,
    "canonicalKey" TEXT NOT NULL,
    "outcomeName" TEXT NOT NULL,
    "edge" DOUBLE PRECISION NOT NULL,
    "bookSum" DOUBLE PRECISION NOT NULL,
    "legs" JSONB NOT NULL,
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "arbitrage_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "steam_moves" (
    "id" TEXT NOT NULL,
    "platform" "Platform" NOT NULL,
    "marketId" TEXT NOT NULL,
    "outcomeName" TEXT,
    "fromProb" DECIMAL(10,6) NOT NULL,
    "toProb" DECIMAL(10,6) NOT NULL,
    "movePct" DOUBLE PRECISION NOT NULL,
    "windowMs" INTEGER NOT NULL,
    "noVisibleWhale" BOOLEAN NOT NULL DEFAULT true,
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "steam_moves_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "markets_canonicalKey_idx" ON "markets"("canonicalKey");

-- CreateIndex
CREATE INDEX "markets_eventType_idx" ON "markets"("eventType");

-- CreateIndex
CREATE INDEX "markets_status_idx" ON "markets"("status");

-- CreateIndex
CREATE INDEX "markets_team_idx" ON "markets"("team");

-- CreateIndex
CREATE INDEX "markets_platform_status_idx" ON "markets"("platform", "status");

-- CreateIndex
CREATE UNIQUE INDEX "markets_platform_externalId_key" ON "markets"("platform", "externalId");

-- CreateIndex
CREATE INDEX "wallets_platform_idx" ON "wallets"("platform");

-- CreateIndex
CREATE INDEX "wallets_lastSeen_idx" ON "wallets"("lastSeen");

-- CreateIndex
CREATE UNIQUE INDEX "wallets_platform_address_key" ON "wallets"("platform", "address");

-- CreateIndex
CREATE UNIQUE INDEX "wallet_stats_walletId_key" ON "wallet_stats"("walletId");

-- CreateIndex
CREATE INDEX "wallet_stats_roi_idx" ON "wallet_stats"("roi");

-- CreateIndex
CREATE INDEX "wallet_stats_totalStakedUsd_idx" ON "wallet_stats"("totalStakedUsd");

-- CreateIndex
CREATE INDEX "wallet_stats_sharpe_idx" ON "wallet_stats"("sharpe");

-- CreateIndex
CREATE INDEX "trades_marketId_timestamp_idx" ON "trades"("marketId", "timestamp");

-- CreateIndex
CREATE INDEX "trades_walletId_timestamp_idx" ON "trades"("walletId", "timestamp");

-- CreateIndex
CREATE INDEX "trades_walletAddress_idx" ON "trades"("walletAddress");

-- CreateIndex
CREATE INDEX "trades_sizeUsd_idx" ON "trades"("sizeUsd");

-- CreateIndex
CREATE INDEX "trades_timestamp_idx" ON "trades"("timestamp");

-- CreateIndex
CREATE INDEX "trades_platform_timestamp_idx" ON "trades"("platform", "timestamp");

-- CreateIndex
CREATE UNIQUE INDEX "trades_platform_externalId_key" ON "trades"("platform", "externalId");

-- CreateIndex
CREATE INDEX "order_books_marketId_timestamp_idx" ON "order_books"("marketId", "timestamp");

-- CreateIndex
CREATE INDEX "order_books_timestamp_idx" ON "order_books"("timestamp");

-- CreateIndex
CREATE INDEX "market_snapshots_marketId_timestamp_idx" ON "market_snapshots"("marketId", "timestamp");

-- CreateIndex
CREATE INDEX "market_snapshots_timestamp_idx" ON "market_snapshots"("timestamp");

-- CreateIndex
CREATE UNIQUE INDEX "whale_signals_tradeId_key" ON "whale_signals"("tradeId");

-- CreateIndex
CREATE INDEX "whale_signals_score_idx" ON "whale_signals"("score");

-- CreateIndex
CREATE INDEX "whale_signals_timestamp_idx" ON "whale_signals"("timestamp");

-- CreateIndex
CREATE INDEX "whale_signals_walletId_idx" ON "whale_signals"("walletId");

-- CreateIndex
CREATE INDEX "whale_signals_marketId_timestamp_idx" ON "whale_signals"("marketId", "timestamp");

-- CreateIndex
CREATE INDEX "whale_signals_tier_timestamp_idx" ON "whale_signals"("tier", "timestamp");

-- CreateIndex
CREATE UNIQUE INDEX "alerts_dedupeKey_key" ON "alerts"("dedupeKey");

-- CreateIndex
CREATE INDEX "alerts_type_createdAt_idx" ON "alerts"("type", "createdAt");

-- CreateIndex
CREATE INDEX "alerts_severity_createdAt_idx" ON "alerts"("severity", "createdAt");

-- CreateIndex
CREATE INDEX "alerts_createdAt_idx" ON "alerts"("createdAt");

-- CreateIndex
CREATE INDEX "alerts_delivered_idx" ON "alerts"("delivered");

-- CreateIndex
CREATE INDEX "arbitrage_events_canonicalKey_idx" ON "arbitrage_events"("canonicalKey");

-- CreateIndex
CREATE INDEX "arbitrage_events_detectedAt_idx" ON "arbitrage_events"("detectedAt");

-- CreateIndex
CREATE INDEX "arbitrage_events_edge_idx" ON "arbitrage_events"("edge");

-- CreateIndex
CREATE INDEX "steam_moves_marketId_detectedAt_idx" ON "steam_moves"("marketId", "detectedAt");

-- CreateIndex
CREATE INDEX "steam_moves_detectedAt_idx" ON "steam_moves"("detectedAt");

-- AddForeignKey
ALTER TABLE "wallet_stats" ADD CONSTRAINT "wallet_stats_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "wallets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trades" ADD CONSTRAINT "trades_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "markets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trades" ADD CONSTRAINT "trades_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "wallets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_books" ADD CONSTRAINT "order_books_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "markets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "market_snapshots" ADD CONSTRAINT "market_snapshots_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "markets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whale_signals" ADD CONSTRAINT "whale_signals_tradeId_fkey" FOREIGN KEY ("tradeId") REFERENCES "trades"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whale_signals" ADD CONSTRAINT "whale_signals_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "markets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whale_signals" ADD CONSTRAINT "whale_signals_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "wallets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "markets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "steam_moves" ADD CONSTRAINT "steam_moves_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "markets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
