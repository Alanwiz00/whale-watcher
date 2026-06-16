/**
 * One-off discovery diagnostic — proves the engine now finds World Cup *match*
 * markets (per-game winner/draw) and can pull their trades.
 *
 *   pnpm --filter @whale/collectors diagnose
 *
 * Runs the real PolymarketCollector against the live Gamma API: discovers
 * markets, breaks them down by event type, lists the biggest match markets, then
 * fetches recent trades for the highest-volume one.
 */
import { config } from '@whale/core';
import { PolymarketCollector } from './collectors/polymarket.js';

const fmt = (n: unknown) => `$${Math.round(Number(n) || 0).toLocaleString('en-US')}`;

async function main(): Promise<void> {
  const c = new PolymarketCollector();
  const { markets, tracked } = await c.discoverMarkets();

  const byType: Record<string, number> = {};
  for (const m of markets) byType[m.eventType] = (byType[m.eventType] ?? 0) + 1;

  console.log(`\nDiscovered ${markets.length} Polymarket WC markets`);
  console.log('By event type:', byType);
  console.log(
    `Filters: MIN_TRADE_USD=${config.MIN_TRADE_USD} INGEST_SELLS=${config.INGEST_SELLS} ` +
      `MARKET_DECIDED_PRICE=${config.MARKET_DECIDED_PRICE} ` +
      `MAX_TRADE_LOOKBACK_MS=${config.MAX_TRADE_LOOKBACK_MS} TRADES_INTERVAL_MS=${config.TRADES_INTERVAL_MS}`,
  );

  // Walk the busiest tracked markets and run the exact worker filter chain, so we
  // can see how many trades would actually be ENQUEUED (and where the rest go).
  const byVol = [...tracked].sort((a, b) => (Number(b.volumeUsd) || 0) - (Number(a.volumeUsd) || 0));
  const sample = byVol.slice(0, 25);
  let total = 0;
  let sells = 0;
  let decided = 0;
  let dust = 0;
  let kept = 0;
  const keptExamples: string[] = [];
  for (const m of sample) {
    const trades = await c.fetchTrades(m); // already floored to the look-back window
    for (const t of trades) {
      total++;
      if (!config.INGEST_SELLS && t.side === 'sell') {
        sells++;
        continue;
      }
      if (t.price >= config.MARKET_DECIDED_PRICE) {
        decided++;
        continue;
      }
      if ((t.sizeUsd ?? 0) < config.MIN_TRADE_USD) {
        dust++;
        continue;
      }
      kept++;
      if (keptExamples.length < 8) {
        keptExamples.push(`${t.side.toUpperCase()} ${fmt(t.sizeUsd)} @ ${(t.price * 100).toFixed(1)}%  ${m.title}`);
      }
    }
  }

  console.log(`\nTrade funnel over top ${sample.length} markets (last look-back window):`);
  console.log(`  fetched:        ${total}`);
  console.log(`  dropped sell:   ${sells}`);
  console.log(`  dropped decided:${decided}  (price ≥ ${config.MARKET_DECIDED_PRICE})`);
  console.log(`  dropped dust:   ${dust}  (< $${config.MIN_TRADE_USD})`);
  console.log(`  ENQUEUED:       ${kept}`);
  for (const e of keptExamples) console.log(`    • ${e}`);

  if (total === 0) {
    console.log('\n⚠️  No trades fetched at all — likely no live activity in the look-back window,');
    console.log('    or MAX_TRADE_LOOKBACK_MS ≤ TRADES_INTERVAL_MS (trades fall in the poll gap).');
  } else if (kept === 0) {
    console.log('\n⚠️  Trades fetched but all filtered out — loosen MIN_TRADE_USD / INGEST_SELLS / MARKET_DECIDED_PRICE.');
  } else {
    console.log(`\n✅ ${kept} trades would be enqueued — ingestion is working.`);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
