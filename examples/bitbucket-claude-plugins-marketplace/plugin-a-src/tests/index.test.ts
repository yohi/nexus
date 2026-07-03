import { describe, it, expect } from 'vitest';
import { greet } from '../src/index';

describe('greet', () => {
  it('returns a personalized greeting', () => {
    expect(greet('World')).toBe('Hello from Plugin A, World!');
  });
});
