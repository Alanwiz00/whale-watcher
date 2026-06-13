import { PrismaClient } from '@prisma/client';

/**
 * Singleton Prisma client. In dev, guard against connection storms from hot
 * reload by stashing the instance on globalThis.
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  });

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;

export * from '@prisma/client';
export { Prisma } from '@prisma/client';

/** Map a human whale-tier label (from @whale/core) to the DB enum. */
export function tierToEnum(label: string): 'elite' | 'strong' | 'notable' | 'normal' {
  switch (label) {
    case 'Elite Whale':
      return 'elite';
    case 'Strong Whale':
      return 'strong';
    case 'Notable Whale':
      return 'notable';
    default:
      return 'normal';
  }
}
