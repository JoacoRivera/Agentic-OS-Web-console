import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calendarDay, daysBetween, localIsoDay } from '../src/dates.js';

test('calendarDay accepts real days and rejects impossible or mis-shaped ones', () => {
  assert.equal(calendarDay('2026-02-28'), '2026-02-28');
  assert.equal(calendarDay('2028-02-29'), '2028-02-29');
  for (const bad of ['2026-02-29', '2026-13-45', '2026-7-1', '2026-07-01T00:00:00', 'soon', '', null, 20260701]) {
    assert.equal(calendarDay(bad), null, String(bad));
  }
});

test('localIsoDay is the local calendar day, zero-padded', () => {
  assert.equal(localIsoDay(new Date(2026, 0, 5, 23, 59)), '2026-01-05');
  assert.equal(localIsoDay(new Date(2026, 10, 14, 0, 0)), '2026-11-14');
});

test('daysBetween counts whole calendar days, signed, across DST changes', () => {
  assert.equal(daysBetween('2026-11-14', '2026-11-14'), 0);
  assert.equal(daysBetween('2026-08-16', '2026-11-14'), 90);
  assert.equal(daysBetween('2026-03-01', '2026-04-01'), 31);
  assert.equal(daysBetween('2026-11-14', '2026-11-01'), -13);
  assert.equal(daysBetween('2025-12-31', '2026-01-01'), 1);
});
