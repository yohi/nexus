import { describe } from 'vitest';

import { vectorStoreContractTests } from '../../shared/vector-store-contract.js';
import { InMemoryVectorStore } from './in-memory-vector-store.js';

describe('InMemoryVectorStore', () => {
  vectorStoreContractTests(async () => ({
    store: new InMemoryVectorStore({ dimensions: 64 }),
    cleanup: async () => {},
  }));
});