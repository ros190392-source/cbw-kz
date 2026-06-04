import { LocaleCode, LocaleDefinition } from '../../src/types';

/**
 * Locale definitions + GEO→language mapping for CBW expansion (EPIC 004).
 *
 * Foundation data only. Markets covered: Kazakhstan, Germany, Turkey, Nigeria,
 * India. `en-US` is the universal fallback. Preferred exchanges reference slugs
 * in the exchange registry; availability is still gated by the GEO engine.
 */

export const LOCALES: Record<LocaleCode, LocaleDefinition> = {
  'kk-KZ': {
    code: 'kk-KZ', language: 'kk', languageName: 'Kazakh', country: 'KZ',
    fallback: 'ru-KZ', defaultCurrency: 'KZT', timezone: 'Asia/Almaty',
    preferredExchanges: ['bybit', 'binance', 'okx'],
    localPaymentMethods: ['Kaspi', 'Halyk', 'Freedom'],
  },
  'ru-KZ': {
    code: 'ru-KZ', language: 'ru', languageName: 'Russian', country: 'KZ',
    fallback: 'en-US', defaultCurrency: 'KZT', timezone: 'Asia/Almaty',
    preferredExchanges: ['bybit', 'binance', 'okx'],
    localPaymentMethods: ['Kaspi', 'Halyk', 'Freedom'],
  },
  'en-US': {
    code: 'en-US', language: 'en', languageName: 'English', country: 'US',
    fallback: null, defaultCurrency: 'USD', timezone: 'America/New_York',
    preferredExchanges: ['kraken', 'coinbase'],
    localPaymentMethods: ['Visa', 'Mastercard', 'ACH'],
  },
  'de-DE': {
    code: 'de-DE', language: 'de', languageName: 'German', country: 'DE',
    fallback: 'en-US', defaultCurrency: 'EUR', timezone: 'Europe/Berlin',
    preferredExchanges: ['bybit', 'binance', 'okx', 'kraken'],
    localPaymentMethods: ['SEPA', 'Visa', 'Mastercard'],
  },
  'tr-TR': {
    code: 'tr-TR', language: 'tr', languageName: 'Turkish', country: 'TR',
    fallback: 'en-US', defaultCurrency: 'TRY', timezone: 'Europe/Istanbul',
    preferredExchanges: ['binance', 'okx', 'bybit'],
    localPaymentMethods: ['Papara', 'bank-transfer', 'Visa', 'Mastercard'],
  },
  'hi-IN': {
    code: 'hi-IN', language: 'hi', languageName: 'Hindi', country: 'IN',
    fallback: 'en-US', defaultCurrency: 'INR', timezone: 'Asia/Kolkata',
    preferredExchanges: ['bybit', 'okx', 'mexc'],
    localPaymentMethods: ['UPI', 'IMPS', 'bank-transfer'],
  },
};

/** GEO (country) → ordered preferred locales. Falls back to en-US. */
export const GEO_LOCALES: Record<string, LocaleCode[]> = {
  KZ: ['ru-KZ', 'kk-KZ'],
  DE: ['de-DE', 'en-US'],
  TR: ['tr-TR'],
  IN: ['hi-IN', 'en-US'],
  NG: ['en-US'],
  US: ['en-US'],
};

export const DEFAULT_LOCALE: LocaleCode = 'en-US';
