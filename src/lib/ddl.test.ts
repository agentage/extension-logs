import { describe, expect, it } from 'vitest';
import { EVENTS_DDL } from './ddl.js';

describe('the events DDL', () => {
  it('is idempotent: 20 columns, created only when missing', () => {
    expect(EVENTS_DDL.startsWith('CREATE TABLE IF NOT EXISTS events (')).toBe(true);
    const columns = EVENTS_DDL.split('\n').filter((line) => /^ {2}[a-z_]+ +[A-Z]/.test(line));
    expect(columns).toHaveLength(20);
  });
});
