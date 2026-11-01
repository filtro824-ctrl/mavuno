export type DurationUnit = 'minutes' | 'hours' | 'days';

const unitSeconds: Record<DurationUnit, number> = {
  minutes: 60,
  hours: 60 * 60,
  days: 24 * 60 * 60,
};

export function durationSeconds(amount: number, unit: DurationUnit): number {
  return amount * unitSeconds[unit];
}

export function durationInRange(seconds: number, minimum: number, maximum: number): boolean {
  return Number.isSafeInteger(seconds) && seconds >= minimum && seconds <= maximum;
}

export function isBanActive(revokedAt: Date | null, expiresAt: Date | null, now = new Date()): boolean {
  return revokedAt === null && (expiresAt === null || expiresAt.getTime() > now.getTime());
}

export function canActOnHierarchy(actorHierarchy: number | null, targetHierarchy: number | null, targetRole: string | null): boolean {
  return actorHierarchy !== null && targetHierarchy !== null && targetRole !== null && targetRole !== 'owner' && actorHierarchy > targetHierarchy;
}
