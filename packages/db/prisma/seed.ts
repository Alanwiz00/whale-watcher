/**
 * Minimal reference seed. Real market/trade data flows in from the collectors;
 * this just inserts a couple of canonical World Cup 2026 markets so the API and
 * dashboard render something on a fresh DB.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const markets = [
    {
      platform: 'polymarket' as const,
      externalId: 'seed-wc2026-winner',
      title: 'Who will win the 2026 FIFA World Cup?',
      eventType: 'tournament_winner' as const,
      team: null,
      canonicalKey: 'wc2026:winner',
      status: 'open' as const,
      volumeUsd: '12500000',
      liquidityUsd: '850000',
    },
    {
      platform: 'kalshi' as const,
      externalId: 'seed-wc2026-brazil-semi',
      title: 'Will Brazil reach the 2026 World Cup semifinals?',
      eventType: 'reach_stage' as const,
      team: 'brazil',
      canonicalKey: 'wc2026:brazil:semifinal',
      status: 'open' as const,
      volumeUsd: '430000',
      liquidityUsd: '95000',
    },
  ];

  for (const m of markets) {
    await prisma.market.upsert({
      where: { platform_externalId: { platform: m.platform, externalId: m.externalId } },
      create: m,
      update: m,
    });
  }

  // eslint-disable-next-line no-console
  console.log(`Seeded ${markets.length} reference markets.`);
}

main()
  .catch((e) => {
    // eslint-disable-next-line no-console
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
