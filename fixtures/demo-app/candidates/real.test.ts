import { validateTransfer, formatFee, TransferRequest } from '../TransferValidator';

const base = (over: Partial<TransferRequest> = {}): TransferRequest => ({
  amount: 1000,
  currency: 'INR',
  beneficiaryId: 'BEN-1',
  channel: 'IMPS',
  ...over,
});

describe('validateTransfer', () => {
  it('accepts a valid IMPS transfer and charges the IMPS fee', () => {
    const r = validateTransfer(base(), true);
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
    expect(r.feeInPaise).toBe(500);
  });

  it('rejects a blank beneficiary', () => {
    expect(validateTransfer(base({ beneficiaryId: '   ' }), true).errors).toContain(
      'BENEFICIARY_REQUIRED'
    );
  });

  it('rejects a non-positive amount and skips limit checks', () => {
    const r = validateTransfer(base({ amount: 0 }), true);
    expect(r.errors).toContain('AMOUNT_INVALID');
    expect(r.errors).not.toContain('BELOW_MIN_IMPS');
  });

  it('rejects an amount below the channel minimum', () => {
    expect(validateTransfer(base({ channel: 'RTGS', amount: 199999 }), true).errors).toContain(
      'BELOW_MIN_RTGS'
    );
  });

  it('rejects an amount above the channel maximum', () => {
    expect(validateTransfer(base({ channel: 'UPI', amount: 100001 }), true).errors).toContain(
      'ABOVE_MAX_UPI'
    );
  });

  it('allows a KYC-verified NEFT transfer over the max, for a 25.00 fee', () => {
    const r = validateTransfer(base({ channel: 'NEFT', amount: 1000001 }), true);
    expect(r.ok).toBe(true);
    expect(r.feeInPaise).toBe(2500);
  });

  it('blocks an un-verified NEFT transfer over the max', () => {
    const r = validateTransfer(base({ channel: 'NEFT', amount: 1000001 }), false);
    expect(r.errors).toContain('ABOVE_MAX_NEFT');
    expect(r.ok).toBe(false);
  });

  it('rejects non-INR on every channel except RTGS', () => {
    expect(validateTransfer(base({ currency: 'USD' }), true).errors).toContain(
      'CURRENCY_NOT_SUPPORTED'
    );
    expect(
      validateTransfer(base({ currency: 'USD', channel: 'RTGS', amount: 250000 }), true).errors
    ).not.toContain('CURRENCY_NOT_SUPPORTED');
  });

  it('requires KYC above 50000 and not at or below it', () => {
    expect(validateTransfer(base({ amount: 50001 }), false).errors).toContain('KYC_REQUIRED');
    expect(validateTransfer(base({ amount: 50000 }), false).errors).not.toContain('KYC_REQUIRED');
  });

  it('rejects an unparseable schedule', () => {
    expect(validateTransfer(base({ scheduledAt: 'not-a-date' }), true).errors).toContain(
      'SCHEDULE_INVALID'
    );
  });

  it('rejects a schedule in the past but allows one in the future', () => {
    expect(validateTransfer(base({ scheduledAt: '2001-01-01T00:00:00Z' }), true).errors).toContain(
      'SCHEDULE_IN_PAST'
    );
    const future = validateTransfer(base({ scheduledAt: '2099-01-01T00:00:00Z' }), true);
    expect(future.errors).not.toContain('SCHEDULE_IN_PAST');
    expect(future.ok).toBe(true);
  });

  it('charges 50.00 for RTGS and nothing for UPI', () => {
    expect(validateTransfer(base({ channel: 'RTGS', amount: 250000 }), true).feeInPaise).toBe(5000);
    expect(validateTransfer(base({ channel: 'UPI' }), true).feeInPaise).toBe(0);
  });

  it('charges no fee when validation failed', () => {
    expect(validateTransfer(base({ beneficiaryId: '' }), true).feeInPaise).toBe(0);
  });
});

describe('formatFee', () => {
  it('renders zero as Free', () => {
    expect(formatFee(0)).toBe('Free');
  });

  it('renders paise as rupees to two decimals', () => {
    expect(formatFee(500)).toBe('₹5.00');
    expect(formatFee(2500)).toBe('₹25.00');
    expect(formatFee(1)).toBe('₹0.01');
  });
});
