import { evaluateQuota, formatCredits, QuotaRequest } from '../QuotaPolicy';

const base = (over: Partial<QuotaRequest> = {}): QuotaRequest => ({
  units: 100,
  region: 'global',
  accountId: 'ACC-1',
  tier: 'free',
  ...over,
});

describe('evaluateQuota', () => {
  it('allows a valid free-tier request at no credit cost', () => {
    const r = evaluateQuota(base(), true);
    expect(r.allowed).toBe(true);
    expect(r.reasons).toEqual([]);
    expect(r.costInCredits).toBe(0);
  });

  it('rejects a blank account id', () => {
    expect(evaluateQuota(base({ accountId: '   ' }), true).reasons).toContain('ACCOUNT_REQUIRED');
  });

  it('rejects non-positive units and skips the limit checks', () => {
    const r = evaluateQuota(base({ units: 0 }), true);
    expect(r.reasons).toContain('UNITS_INVALID');
    expect(r.reasons).not.toContain('BELOW_MIN_FREE');
  });

  it('rejects units below the tier minimum', () => {
    expect(evaluateQuota(base({ tier: 'enterprise', units: 999 }), true).reasons).toContain(
      'BELOW_MIN_ENTERPRISE'
    );
  });

  it('rejects units above the tier maximum', () => {
    expect(evaluateQuota(base({ tier: 'trial', units: 101 }), true).reasons).toContain(
      'ABOVE_MAX_TRIAL'
    );
  });

  it('allows a verified pro account to exceed its maximum for 25.00 credits', () => {
    const r = evaluateQuota(base({ tier: 'pro', units: 50001 }), true);
    expect(r.allowed).toBe(true);
    expect(r.costInCredits).toBe(2500);
  });

  it('blocks an unverified pro account above its maximum', () => {
    const r = evaluateQuota(base({ tier: 'pro', units: 50001 }), false);
    expect(r.reasons).toContain('ABOVE_MAX_PRO');
    expect(r.allowed).toBe(false);
  });

  it('rejects a restricted region on every tier except enterprise', () => {
    expect(evaluateQuota(base({ region: 'restricted' }), true).reasons).toContain(
      'REGION_NOT_SUPPORTED'
    );
    expect(
      evaluateQuota(base({ region: 'restricted', tier: 'enterprise', units: 2000 }), true).reasons
    ).not.toContain('REGION_NOT_SUPPORTED');
  });

  it('requires verification above 500 units and not at or below it', () => {
    expect(evaluateQuota(base({ units: 501 }), false).reasons).toContain('VERIFICATION_REQUIRED');
    expect(evaluateQuota(base({ units: 500 }), false).reasons).not.toContain('VERIFICATION_REQUIRED');
  });

  it('rejects an unparseable schedule', () => {
    expect(evaluateQuota(base({ scheduledAt: 'not-a-date' }), true).reasons).toContain(
      'SCHEDULE_INVALID'
    );
  });

  it('rejects a schedule in the past but allows one in the future', () => {
    expect(evaluateQuota(base({ scheduledAt: '2001-01-01T00:00:00Z' }), true).reasons).toContain(
      'SCHEDULE_IN_PAST'
    );
    const future = evaluateQuota(base({ scheduledAt: '2099-01-01T00:00:00Z' }), true);
    expect(future.reasons).not.toContain('SCHEDULE_IN_PAST');
    expect(future.allowed).toBe(true);
  });

  it('charges 50.00 credits for enterprise and nothing for trial', () => {
    expect(evaluateQuota(base({ tier: 'enterprise', units: 2000 }), true).costInCredits).toBe(5000);
    expect(evaluateQuota(base({ tier: 'trial' }), true).costInCredits).toBe(0);
  });

  it('charges nothing when the request was rejected', () => {
    expect(evaluateQuota(base({ accountId: '' }), true).costInCredits).toBe(0);
  });
});

describe('formatCredits', () => {
  it('renders zero as Included', () => {
    expect(formatCredits(0)).toBe('Included');
  });

  it('renders hundredths as credits to two decimals', () => {
    expect(formatCredits(500)).toBe('5.00 credits');
    expect(formatCredits(2500)).toBe('25.00 credits');
    expect(formatCredits(1)).toBe('0.01 credits');
  });
});
