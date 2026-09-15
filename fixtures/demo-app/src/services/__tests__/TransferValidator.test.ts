import { validateTransfer } from '../TransferValidator';

// The kind of test that already exists in most repos: happy path only.
describe('validateTransfer', () => {
  it('accepts a valid IMPS transfer', () => {
    const r = validateTransfer(
      { amount: 1000, currency: 'INR', beneficiaryId: 'B1', channel: 'IMPS' },
      true
    );
    expect(r.ok).toBe(true);
  });
});
