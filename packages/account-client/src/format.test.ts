import { describe, it, expect } from 'vitest';
import { formatMoney, formatDate, formatAsOf, formatAddress, kindLabel, statusLabel, statusTone, displayNumber } from './format.ts';

describe('format', () => {
  it('formats money with grouping and currency', () => {
    expect(formatMoney('1234567.80')).toBe('$1,234,567.80');
    expect(formatMoney('-12.00')).toBe('-$12.00');
    expect(formatMoney('0.00', 'GBP')).toBe('£0.00');
    expect(formatMoney('5.00', 'CHF')).toBe('CHF 5.00');
  });
  it('handles null/invalid money', () => {
    expect(formatMoney(null)).toBe('—');
    expect(formatMoney('abc')).toBe('—');
  });
  it('formats dates without tz shift', () => {
    expect(formatDate('2026-03-05')).toBe('Mar 5, 2026');
    expect(formatDate('2026-12-31T23:59:00Z')).toBe('Dec 31, 2026');
    expect(formatDate(null)).toBe('—');
    expect(formatDate('garbage')).toBe('—');
  });
  it('formats as-of in UTC', () => {
    expect(formatAsOf('2026-10-20T14:05:00Z')).toBe('Oct 20, 2026, 14:05 UTC');
    expect(formatAsOf('nope')).toBe('—');
  });
  it('labels', () => {
    expect(kindLabel('credit_note')).toBe('Credit note');
    expect(statusLabel('partially_paid')).toBe('Partially paid');
    expect(statusLabel('')).toBe('—');
  });
});

describe('grid helpers', () => {
  it('maps statuses to badge tones', () => {
    expect(statusTone('overdue')).toBe('critical');
    expect(statusTone('Paid')).toBe('success');
    expect(statusTone('sent')).toBe('info');
    expect(statusTone('partially_paid')).toBe('warning');
    expect(statusTone('whatever')).toBe('neutral');
  });
  it('prefixes bare payment numbers only', () => {
    expect(displayNumber('payment', '17816')).toBe('Pmt 17816');
    expect(displayNumber('invoice', 'INV-1')).toBe('INV-1');
  });
});

describe('formatAddress', () => {
  it('joins the parts and skips empty ones', () => {
    expect(formatAddress({ address1: '1 Main St', address2: null, city: 'Denver', province: 'CO', zip: '80202', country: 'US' }))
      .toEqual(['1 Main St', 'Denver, CO 80202', 'US']);
    expect(formatAddress({ address1: '1 Main St', address2: 'Suite 4', city: null, province: null, zip: null, country: null }))
      .toEqual(['1 Main St', 'Suite 4']);
  });
  it('returns nothing for a missing address', () => {
    expect(formatAddress(null)).toEqual([]);
    expect(formatAddress(undefined)).toEqual([]);
  });
});
