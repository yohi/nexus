import type { Profile } from './contracts.js';
import { profiles } from './profiles.js';
import { describeRecipe } from './fixture-recipe.js';
import { fixtureQueries } from './fixture-queries.js';
import type { JobKind } from './worker-contracts.js';

export async function expectedJobIds(kind: JobKind, profile: Profile): Promise<readonly string[]> {
  switch (kind) {
    case 'siblings': return ['sibling_first', 'sibling_second'];
    case 'cold_initial_index': case 'l1_replay': case 'l2_rebuild': case 'warm_restart': case 'incremental': return [kind];
    case 'warm': case 'first_call': {
      const scale = profiles[profile];
      const descriptor = await describeRecipe(0, scale.files, scale.declarationsPerFile);
      return fixtureQueries([descriptor], scale.files, scale.declarationsPerFile)
        .map((query) => `${kind === 'warm' ? 'warm' : 'first'}-${query.id}`);
    }
  }
}
