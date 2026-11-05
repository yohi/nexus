import type { FixtureProfile } from './fixture-recipe.mjs';

export type FixtureSizeSummary = Readonly<{
  files: number;
  utf8Bytes: number;
  declarations: number;
  imports: number;
  legacyRows: number;
  structuredRows: number;
}>;

export function measureFixtureSize(profile: FixtureProfile): FixtureSizeSummary;
