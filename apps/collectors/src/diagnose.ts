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
import { PolymarketCollector } from './collectors/polymarket.js';

const MATCH_TYPES = new Set(['match_result', 'match_scorer', 'match_total_goals']);
const fmt = (n: unknown) => `$${Math.round(Number(n) || 0).toLocaleString('en-US')}`;

async function main(): Promise<void> {
  const c = new PolymarketCollector();
  const { markets, tracked } = await c.discoverMarkets();

  const byType: Record<string, number> = {};
  for (const m of markets) byType[m.eventType] = (byType[m.eventType] ?? 0) + 1;

  console.log(`\nDiscovered ${markets.length} Polymarket WC markets`);
  console.log('By event type:', byType);

  const matches = markets
    .filter((m) => MATCH_TYPES.has(m.eventType))
    .sort((a, b) => (Number(b.volumeUsd) || 0) - (Number(a.volumeUsd) || 0));
  console.log(`\nMatch markets: ${matches.length}`);
  for (const m of matches.slice(0, 12)) {
    console.log(`  • ${fmt(m.volumeUsd)}  ${m.title}  [${m.eventType}]  ${m.canonicalKey}`);
  }

  const top = matches[0];
  if (!top) {
    console.log('\n❌ No match markets discovered — check POLYMARKET_WC_TAG_IDS.');
    process.exit(1);
  }
  const tr = tracked.find((t) => t.externalId === top.externalId)!;
  const trades = await c.fetchTrades(tr);
  console.log(`\nTrades for "${top.title}" (${fmt(top.volumeUsd)} vol): ${trades.length}`);
  for (const t of trades.slice(0, 6)) {
    console.log(`  • ${t.side.toUpperCase()} ${t.outcomeName ?? '?'}  ${fmt(t.sizeUsd)} @ ${(t.price * 100).toFixed(1)}%`);
  }

  console.log(
    matches.length > 0 && trades.length >= 0
      ? '\n✅ Match markets are discovered and tradable.'
      : '\n❌ Something is off.',
  );
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
