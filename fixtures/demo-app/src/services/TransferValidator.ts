export interface TransferRequest {
  amount: number;
  currency: 'INR' | 'USD';
  beneficiaryId: string;
  channel: 'IMPS' | 'NEFT' | 'RTGS' | 'UPI';
  scheduledAt?: string;
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  feeInPaise: number;
}

const LIMITS: Record<TransferRequest['channel'], { min: number; max: number }> = {
  IMPS: { min: 1, max: 500000 },
  NEFT: { min: 1, max: 1000000 },
  RTGS: { min: 200000, max: 10000000 },
  UPI: { min: 1, max: 100000 },
};

/**
 * Deliberately branchy — this is the shape of file that shows up in triage:
 * high cognitive complexity, low coverage, high churn.
 */
export function validateTransfer(req: TransferRequest, isKycVerified: boolean): ValidationResult {
  const errors: string[] = [];
  let feeInPaise = 0;

  if (!req.beneficiaryId || req.beneficiaryId.trim().length === 0) {
    errors.push('BENEFICIARY_REQUIRED');
  }

  if (req.amount <= 0) {
    errors.push('AMOUNT_INVALID');
  } else {
    const limit = LIMITS[req.channel];
    if (req.amount < limit.min) {
      errors.push(`BELOW_MIN_${req.channel}`);
    } else if (req.amount > limit.max) {
      if (isKycVerified && req.channel === 'NEFT') {
        feeInPaise = 2500;
      } else {
        errors.push(`ABOVE_MAX_${req.channel}`);
      }
    }
  }

  if (req.currency !== 'INR' && req.channel !== 'RTGS') {
    errors.push('CURRENCY_NOT_SUPPORTED');
  }

  if (!isKycVerified && req.amount > 50000) {
    errors.push('KYC_REQUIRED');
  }

  if (req.scheduledAt) {
    const when = Date.parse(req.scheduledAt);
    if (Number.isNaN(when)) {
      errors.push('SCHEDULE_INVALID');
    } else if (when < Date.now()) {
      errors.push('SCHEDULE_IN_PAST');
    }
  }

  if (errors.length === 0 && feeInPaise === 0) {
    feeInPaise = req.channel === 'RTGS' ? 5000 : req.channel === 'IMPS' ? 500 : 0;
  }

  return { ok: errors.length === 0, errors, feeInPaise };
}

export function formatFee(feeInPaise: number): string {
  if (feeInPaise === 0) return 'Free';
  return `₹${(feeInPaise / 100).toFixed(2)}`;
}
