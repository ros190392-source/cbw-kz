import { GeoGuideProfile } from '../../src/types';

/**
 * GEO guide profiles (EPIC 014 · Phase 4).
 *
 * Conservative, human-verifiable baselines for the markets CBW covers. These are
 * NOT presented as fact — payment rails, restrictions and KYC depth must be
 * confirmed by a local tester before any manual built on them is published. The
 * `locale` / `currency` align with the locale engine (EPIC 004).
 */

/** Country → guide profile. `availabilityNotes`/`kycNotes` are exchange-agnostic
 *  baselines; the manual builder overlays the exchange's own GEO record on top. */
export const GEO_GUIDES: Record<string, GeoGuideProfile> = {
  KZ: {
    geo: 'KZ', country: 'Kazakhstan', locale: 'ru-KZ', currency: 'KZT',
    paymentMethods: ['Kaspi', 'Halyk', 'Freedom', 'local cards'],
    restrictions: [],
    fiatNotes: 'KZT typically available via P2P and local cards (Kaspi/Halyk/Freedom). Verify current rails.',
    kycNotes: 'Basic KYC is common; level can change — confirm before publishing.',
    availabilityNotes: 'Major global exchanges are generally reachable; confirm per-exchange status.',
  },
  TR: {
    geo: 'TR', country: 'Turkey', locale: 'tr-TR', currency: 'TRY',
    paymentMethods: ['Papara', 'bank transfer', 'Visa', 'Mastercard'],
    restrictions: ['Crypto cannot be used for payments under local regulation — verify current rules.'],
    fiatNotes: 'TRY commonly available via P2P and bank transfer. Confirm method availability.',
    kycNotes: 'KYC requirements have tightened — confirm current document requirements.',
    availabilityNotes: 'High adoption; confirm each exchange still serves TR.',
  },
  IN: {
    geo: 'IN', country: 'India', locale: 'hi-IN', currency: 'INR',
    paymentMethods: ['UPI', 'IMPS', 'bank transfer'],
    restrictions: ['Bank access to crypto can be intermittent; TDS/tax rules apply — verify.'],
    fiatNotes: 'INR via UPI/IMPS is common but banking rails fluctuate. Confirm before publishing.',
    kycNotes: 'Full KYC is typically required. Confirm PAN/Aadhaar requirements.',
    availabilityNotes: 'Availability and banking support vary by exchange — verify carefully.',
  },
  NG: {
    geo: 'NG', country: 'Nigeria', locale: 'en-US', currency: 'NGN',
    paymentMethods: ['bank transfer', 'OPay', 'Palmpay'],
    restrictions: ['Banking access to crypto has faced restrictions; P2P is the common rail — verify.'],
    fiatNotes: 'NGN is usually traded via P2P. Direct bank deposits may be limited. Confirm.',
    kycNotes: 'KYC depth varies; confirm current requirements.',
    availabilityNotes: 'P2P-driven market; confirm each exchange still serves NG.',
  },
  DE: {
    geo: 'DE', country: 'Germany', locale: 'de-DE', currency: 'EUR',
    paymentMethods: ['SEPA', 'Visa', 'Mastercard'],
    restrictions: ['Operates under EU/MiCA rules — confirm the exchange is EU-compliant.'],
    fiatNotes: 'EUR via SEPA is standard. Confirm SEPA support for the exchange.',
    kycNotes: 'Full KYC under EU AML rules is expected.',
    availabilityNotes: 'Well served; confirm MiCA/EU compliance per exchange.',
  },
};

export const DEFAULT_GEO = 'KZ';

/** Supported guide GEOs, in display order. */
export const GUIDE_GEOS = ['KZ', 'TR', 'IN', 'NG', 'DE'];

export function geoGuideProfile(country: string): GeoGuideProfile {
  const c = (country ?? '').trim().toUpperCase();
  return GEO_GUIDES[c] ?? GEO_GUIDES[DEFAULT_GEO];
}
