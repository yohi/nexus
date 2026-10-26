import type { Profile } from './contracts.js';

export const profiles = {
  smoke: { files: 20, declarationsPerFile: 5 },
  small: { files: 100, declarationsPerFile: 10 },
  medium: { files: 1_000, declarationsPerFile: 10 },
  large: { files: 10_000, declarationsPerFile: 10 },
} as const satisfies Readonly<Record<Profile, {
  readonly files: number; readonly declarationsPerFile: number;
}>>;
