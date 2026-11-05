export type FixtureProfile = 'smoke' | 'small' | 'medium' | 'large';
export type RecipeVariant = 'initial' | 'modified';
export type FixtureRecipeInput = Readonly<{
  index: number;
  fileCount: number;
  declarationsPerFile: number;
  variant?: RecipeVariant;
}>;
export type FixtureRecipeDraft = Readonly<{
  name: string;
  start: number;
  end: number;
  fullStart: number;
  content: string;
}>;
export type FixtureRecipe = Readonly<{
  text: string;
  importText: string;
  moduleSpecifier: string;
  drafts: readonly FixtureRecipeDraft[];
}>;

export const fixtureProfiles: Readonly<Record<FixtureProfile, Readonly<{
  files: number;
  declarationsPerFile: number;
}>>>;
export function fixturePath(index: number): string;
export function createFixtureRecipe(input: FixtureRecipeInput): FixtureRecipe;
