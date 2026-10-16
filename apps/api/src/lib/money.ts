import { fromFils, toFils } from '@nexera/shared';
import { Prisma } from '../generated/prisma/client';

// NUMERIC(18,3) columns come back as Prisma decimals; the API works in whole fils.
export function decimalToFils(value: Prisma.Decimal): bigint {
  return toFils(value.toFixed(3));
}

export function decimalToAmount(value: Prisma.Decimal): string {
  return value.toFixed(3);
}

export function filsToDecimal(fils: bigint): Prisma.Decimal {
  return new Prisma.Decimal(fromFils(fils));
}
