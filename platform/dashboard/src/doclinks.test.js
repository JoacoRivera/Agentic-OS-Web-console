import { describe, expect, test } from 'vitest';
import { createSlugger } from './doclinks.js';

describe('document heading slugs', () => {
  test('keeps Foo, Foo, and Foo-1 unique in document order', () => {
    const slug = createSlugger();

    expect(['Foo', 'Foo', 'Foo-1'].map(slug)).toEqual([
      'foo',
      'foo-1',
      'foo-1-1',
    ]);
  });
});
