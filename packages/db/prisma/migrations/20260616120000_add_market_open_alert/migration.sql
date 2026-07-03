-- AlterEnum
-- Adds the `market_open` alert type — fired when a watched market (e.g. a fresh
-- Elon-tweets window) is first listed, independent of liquidity.
ALTER TYPE "AlertType" ADD VALUE 'market_open';
