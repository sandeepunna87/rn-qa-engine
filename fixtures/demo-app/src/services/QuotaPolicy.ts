export interface QuotaRequest {
  units: number;
  region: 'global' | 'restricted';
  accountId: string;
  tier: 'trial' | 'free' | 'pro' | 'enterprise';
  scheduledAt?: string;
}

export interface QuotaDecision {
  allowed: boolean;
  reasons: string[];
  costInCredits: number;
}

const LIMITS: Record<QuotaRequest['tier'], { min: number; max: number }> = {
  trial: { min: 1, max: 100 },
  free: { min: 1, max: 1000 },
  pro: { min: 1, max: 50000 },
  enterprise: { min: 1000, max: 1000000 },
};

/**
 * Deliberately branchy. This is the shape of file that surfaces in triage:
 * high cognitive complexity, low coverage, frequently changed.
 *
 * Nothing here is domain-specific — it is a quota policy, the kind of rule
 * engine that exists in almost every application.
 */
export function evaluateQuota(req: QuotaRequest, isVerified: boolean): QuotaDecision {
  const reasons: string[] = [];
  let costInCredits = 0;

  if (!req.accountId || req.accountId.trim().length === 0) {
    reasons.push('ACCOUNT_REQUIRED');
  }

  if (req.units <= 0) {
    reasons.push('UNITS_INVALID');
  } else {
    const limit = LIMITS[req.tier];
    if (req.units < limit.min) {
      reasons.push(`BELOW_MIN_${req.tier.toUpperCase()}`);
    } else if (req.units > limit.max) {
      if (isVerified && req.tier === 'pro') {
        costInCredits = 2500;
      } else {
        reasons.push(`ABOVE_MAX_${req.tier.toUpperCase()}`);
      }
    }
  }

  if (req.region !== 'global' && req.tier !== 'enterprise') {
    reasons.push('REGION_NOT_SUPPORTED');
  }

  if (!isVerified && req.units > 500) {
    reasons.push('VERIFICATION_REQUIRED');
  }

  if (req.scheduledAt) {
    const when = Date.parse(req.scheduledAt);
    if (Number.isNaN(when)) {
      reasons.push('SCHEDULE_INVALID');
    } else if (when < Date.now()) {
      reasons.push('SCHEDULE_IN_PAST');
    }
  }

  if (reasons.length === 0 && costInCredits === 0) {
    costInCredits = req.tier === 'enterprise' ? 5000 : req.tier === 'pro' ? 500 : 0;
  }

  return { allowed: reasons.length === 0, reasons, costInCredits };
}

export function formatCredits(costInCredits: number): string {
  if (costInCredits === 0) return 'Included';
  return `${(costInCredits / 100).toFixed(2)} credits`;
}
