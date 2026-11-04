import type { Profile } from './contracts.js';
import { fixtureProfiles } from '../../../scripts/performance-diagnostics/fixture-recipe.mjs';

export const profiles = fixtureProfiles satisfies Readonly<Record<Profile, Readonly<{
  files: number;
  declarationsPerFile: number;
}>>>;
