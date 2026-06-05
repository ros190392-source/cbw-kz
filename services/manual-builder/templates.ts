import { EvidenceLevel, GuideTopic } from '../../src/types';

/**
 * Step templates per guide topic (EPIC 014 · Phase 1).
 *
 * Honest baselines: steps that depend on a live local action start at evidence
 * level E (needs a local tester) — we have NOT performed these flows. Steps that
 * are documented in official help centres start at C. Nothing is marked verified
 * by default; a local tester raises evidence as real screenshots arrive.
 *
 * `{currency}` and `{payment}` placeholders are filled with GEO data by the
 * builder. `needsScreenshot` marks steps where an interface screenshot is the
 * expected evidence (used by missing-screenshot detection).
 */
export interface StepTemplate {
  id: string;
  title: string;
  description: string;
  /** Baseline evidence level before any real evidence is attached. */
  baseEvidence: EvidenceLevel;
  /** An interface screenshot is the expected proof for this step. */
  needsScreenshot: boolean;
}

const T: Record<GuideTopic, StepTemplate[]> = {
  p2p: [
    { id: 'open-p2p', title: 'Open P2P', description: 'Open the P2P trading section of the exchange.', baseEvidence: 'C', needsScreenshot: true },
    { id: 'select-fiat', title: 'Select {currency}', description: 'Select {currency} as the trading currency.', baseEvidence: 'E', needsScreenshot: true },
    { id: 'filter-payment', title: 'Filter by {payment}', description: 'Filter offers by a local payment method ({payment}).', baseEvidence: 'E', needsScreenshot: true },
    { id: 'review-offer', title: 'Review the merchant', description: 'Check the merchant completion rate, limits and terms before trading.', baseEvidence: 'C', needsScreenshot: false },
    { id: 'place-order', title: 'Place the order', description: 'Place the order and follow the in-app payment instructions.', baseEvidence: 'E', needsScreenshot: true },
    { id: 'confirm-payment', title: 'Confirm after payment', description: 'Mark as paid only after funds are actually sent; release crypto only when received.', baseEvidence: 'E', needsScreenshot: false },
  ],
  kyc: [
    { id: 'open-verification', title: 'Open verification', description: 'Open Account → Identity Verification.', baseEvidence: 'C', needsScreenshot: true },
    { id: 'choose-level', title: 'Choose KYC level', description: 'Choose the verification level required in your region.', baseEvidence: 'C', needsScreenshot: true },
    { id: 'submit-id', title: 'Submit ID', description: 'Submit a valid government ID document.', baseEvidence: 'E', needsScreenshot: true },
    { id: 'liveness', title: 'Liveness check', description: 'Complete the selfie / liveness verification.', baseEvidence: 'E', needsScreenshot: true },
    { id: 'await-approval', title: 'Await approval', description: 'Wait for the verification result; timing varies.', baseEvidence: 'D', needsScreenshot: false },
  ],
  deposit: [
    { id: 'open-deposit', title: 'Open deposit', description: 'Open Deposit and choose fiat or crypto.', baseEvidence: 'C', needsScreenshot: true },
    { id: 'select-method', title: 'Select {payment}', description: 'Select a deposit method available locally ({payment}).', baseEvidence: 'E', needsScreenshot: true },
    { id: 'enter-amount', title: 'Enter amount', description: 'Enter the deposit amount in {currency}.', baseEvidence: 'E', needsScreenshot: true },
    { id: 'confirm-deposit', title: 'Confirm payment', description: 'Confirm and complete the payment with your provider.', baseEvidence: 'E', needsScreenshot: true },
    { id: 'verify-credit', title: 'Verify credit', description: 'Verify the balance is credited to your account.', baseEvidence: 'E', needsScreenshot: true },
  ],
  withdrawal: [
    { id: 'open-withdrawal', title: 'Open withdrawal', description: 'Open Withdraw and choose fiat or crypto.', baseEvidence: 'C', needsScreenshot: true },
    { id: 'select-method', title: 'Select {payment}', description: 'Select a withdrawal method available locally ({payment}).', baseEvidence: 'E', needsScreenshot: true },
    { id: 'enter-details', title: 'Enter details', description: 'Enter the destination details and amount in {currency}.', baseEvidence: 'E', needsScreenshot: true },
    { id: 'security-check', title: 'Security check', description: 'Pass 2FA / withdrawal security checks.', baseEvidence: 'C', needsScreenshot: false },
    { id: 'confirm-withdrawal', title: 'Confirm withdrawal', description: 'Confirm and track the withdrawal status.', baseEvidence: 'E', needsScreenshot: true },
  ],
  launchpool: [
    { id: 'open-launchpool', title: 'Open Launchpool', description: 'Open the Launchpool / Earn section.', baseEvidence: 'C', needsScreenshot: true },
    { id: 'choose-pool', title: 'Choose a pool', description: 'Choose an active pool and read its terms and dates.', baseEvidence: 'D', needsScreenshot: true },
    { id: 'stake-tokens', title: 'Stake tokens', description: 'Stake the required token to start farming rewards.', baseEvidence: 'E', needsScreenshot: true },
    { id: 'track-rewards', title: 'Track rewards', description: 'Track accruing rewards over the pool period.', baseEvidence: 'E', needsScreenshot: false },
    { id: 'claim-rewards', title: 'Claim rewards', description: 'Claim or auto-receive rewards after the pool ends.', baseEvidence: 'E', needsScreenshot: true },
  ],
  bonus: [
    { id: 'open-rewards', title: 'Open rewards hub', description: 'Open the rewards / bonus hub.', baseEvidence: 'D', needsScreenshot: true },
    { id: 'check-eligibility', title: 'Check eligibility', description: 'Check eligibility, region limits and expiry — bonuses change often.', baseEvidence: 'E', needsScreenshot: true },
    { id: 'complete-tasks', title: 'Complete tasks', description: 'Complete the required tasks (deposit, trade, etc.).', baseEvidence: 'E', needsScreenshot: false },
    { id: 'claim-bonus', title: 'Claim bonus', description: 'Claim the reward and confirm it credited.', baseEvidence: 'E', needsScreenshot: true },
  ],
  account_security: [
    { id: 'enable-2fa', title: 'Enable 2FA', description: 'Enable an authenticator-app 2FA (not SMS where possible).', baseEvidence: 'C', needsScreenshot: true },
    { id: 'anti-phishing', title: 'Anti-phishing code', description: 'Set an anti-phishing code so genuine emails are recognisable.', baseEvidence: 'C', needsScreenshot: true },
    { id: 'withdrawal-whitelist', title: 'Withdrawal whitelist', description: 'Whitelist withdrawal addresses to block unknown destinations.', baseEvidence: 'C', needsScreenshot: true },
    { id: 'review-api', title: 'Review API keys', description: 'Review and restrict API keys; remove unused ones.', baseEvidence: 'C', needsScreenshot: false },
    { id: 'device-management', title: 'Device management', description: 'Review active devices/sessions and remove unknown ones.', baseEvidence: 'D', needsScreenshot: true },
  ],
};

export function stepTemplates(topic: GuideTopic): StepTemplate[] {
  return T[topic] ?? [];
}

export const GUIDE_TOPICS: GuideTopic[] = [
  'p2p', 'kyc', 'deposit', 'withdrawal', 'launchpool', 'bonus', 'account_security',
];

export const TOPIC_TITLES: Record<GuideTopic, string> = {
  p2p: 'P2P trading',
  kyc: 'KYC verification',
  deposit: 'Deposit',
  withdrawal: 'Withdrawal',
  launchpool: 'Launchpool',
  bonus: 'Bonus / rewards',
  account_security: 'Account security',
};
