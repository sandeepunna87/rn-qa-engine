import { evaluateQuota } from '../QuotaPolicy';

// The kind of test that already exists in most repos: happy path only.
describe('evaluateQuota', () => {
  it('allows a valid pro request', () => {
    const r = evaluateQuota(
      { units: 1000, region: 'global', accountId: 'A1', tier: 'pro' },
      true
    );
    expect(r.allowed).toBe(true);
  });
});
