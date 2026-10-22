import { it, expect } from 'vitest';
import { toMoney, Money } from './index.js';
it('formats money as 2dp strings', () => { expect(toMoney(1.005 + 1)).toMatch(/^\d+\.\d{2}$/); expect(Money.safeParse('12.50').success).toBe(true); expect(Money.safeParse('12.5').success).toBe(false); });
