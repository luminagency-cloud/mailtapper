import { forbidden } from "../util.js";

/** Tier caps (provisional starting numbers; see the Roadmap). Anchored on connections. */
export type Tier = "free" | "pro" | "scale";

export interface TierCaps {
  connections: number;
  lookbackDays: number;
  pageDefault: number;
  pageMax: number;
  ratePerMin: number;
  dailyRequests: number;
  concurrency: number;
}

export const TIERS: Record<Tier, TierCaps> = {
  free:  { connections: 3,   lookbackDays: 14,  pageDefault: 25, pageMax: 50,  ratePerMin: 10,  dailyRequests: 1_000,   concurrency: 2 },
  pro:   { connections: 50,  lookbackDays: 90,  pageDefault: 25, pageMax: 100, ratePerMin: 120, dailyRequests: 50_000,  concurrency: 10 },
  scale: { connections: 250, lookbackDays: 365, pageDefault: 25, pageMax: 200, ratePerMin: 600, dailyRequests: 250_000, concurrency: 30 },
};

/** Default lookback when the caller omits `since` — recent window, regardless of tier. */
const DEFAULT_LOOKBACK_DAYS = 7;

export function clampLimit(tier: Tier, requested?: number): number {
  const caps = TIERS[tier];
  if (!requested || requested < 1) return caps.pageDefault;
  return Math.min(requested, caps.pageMax);
}

/**
 * Resolve the effective `since`. Omitted -> default recent window. Beyond the tier's
 * lookback cap -> 403 (no silent clamp; the caller should know to upgrade).
 */
export function resolveSince(tier: Tier, since?: string): Date {
  const caps = TIERS[tier];
  const floor = new Date(Date.now() - caps.lookbackDays * 86_400_000);
  if (!since) return new Date(Date.now() - DEFAULT_LOOKBACK_DAYS * 86_400_000);
  const requested = new Date(since);
  if (Number.isNaN(requested.getTime())) throw forbidden("Invalid `since` timestamp");
  if (requested < floor) {
    throw forbidden(`Lookback exceeds your plan (max ${caps.lookbackDays} days). Upgrade to reach further back.`);
  }
  return requested;
}
