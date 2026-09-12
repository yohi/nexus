import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { Chunker } from '../../../src/indexer/chunker.js';
import { IndexPipeline } from '../../../src/indexer/pipeline.js';
import { CLanguagePlugin } from '../../../src/plugins/languages/c.js';
import { CppLanguagePlugin } from '../../../src/plugins/languages/cpp.js';
import { CSharpLanguagePlugin } from '../../../src/plugins/languages/csharp.js';
import { GoLanguagePlugin } from '../../../src/plugins/languages/go.js';
import { JavaLanguagePlugin } from '../../../src/plugins/languages/java.js';
import { PythonLanguagePlugin } from '../../../src/plugins/languages/python.js';
import { RustLanguagePlugin } from '../../../src/plugins/languages/rust.js';
import { TypeScriptLanguagePlugin } from '../../../src/plugins/languages/typescript.js';
import { PluginRegistry } from '../../../src/plugins/registry.js';
import { decodeUtf8, sha256Hex } from '../../../src/structured/hash.js';
import type { StructuredSource } from '../../../src/structured/contracts.js';
import type { IndexEvent, LanguagePlugin } from '../../../src/types/index.js';
import { createStructuredCoordinator } from '../../shared/structured-test-helpers.js';
import { TestEmbeddingProvider } from '../../unit/plugins/embeddings/test-embedding-provider.js';
import { InMemoryMetadataStore } from '../../unit/storage/in-memory-metadata-store.js';
import { InMemoryVectorStore } from '../../unit/storage/in-memory-vector-store.js';

interface NativeLanguageSpec {
  readonly languageId: string;
  readonly plugin: LanguagePlugin;
  readonly extension: string;
  readonly minimalSource: string;
  readonly fixturePath: string;
  readonly fixtureFilePath: string;
}

const LANGUAGES: NativeLanguageSpec[] = [
  {
    languageId: 'rust',
    plugin: new RustLanguagePlugin(),
    extension: 'rs',
    minimalSource: 'fn main() {}\n',
    fixturePath: 'tests/fixtures/structured/rust/exactness.rs',
    fixtureFilePath: 'rust/exactness.rs',
  },
  {
    languageId: 'java',
    plugin: new JavaLanguagePlugin(),
    extension: 'java',
    minimalSource: 'public class Main { public static void main(String[] args) {} }\n',
    fixturePath: 'tests/fixtures/structured/java/Exactness.java',
    fixtureFilePath: 'java/Exactness.java',
  },
  {
    languageId: 'csharp',
    plugin: new CSharpLanguagePlugin(),
    extension: 'cs',
    minimalSource: 'class Program { static void Main() {} }\n',
    fixturePath: 'tests/fixtures/structured/csharp/Exactness.cs',
    fixtureFilePath: 'csharp/Exactness.cs',
  },
  {
    languageId: 'c',
    plugin: new CLanguagePlugin(),
    extension: 'c',
    minimalSource: 'int main(void) { return 0; }\n',
    fixturePath: 'tests/fixtures/structured/c/exactness.c',
    fixtureFilePath: 'c/exactness.c',
  },
  {
    languageId: 'cpp',
    plugin: new CppLanguagePlugin(),
    extension: 'cpp',
    minimalSource: 'int main() { return 0; }\n',
    fixturePath: 'tests/fixtures/structured/cpp/exactness.cpp',
    fixtureFilePath: 'cpp/exactness.cpp',
  },
];

const createProductionRegistry = (): PluginRegistry => {
  const registry = new PluginRegistry();
  registry.registerLanguage(new TypeScriptLanguagePlugin());
  registry.registerLanguage(new PythonLanguagePlugin());
  registry.registerLanguage(new GoLanguagePlugin());
  registry.registerLanguage(new RustLanguagePlugin());
  registry.registerLanguage(new JavaLanguagePlugin());
  registry.registerLanguage(new CSharpLanguagePlugin());
  registry.registerLanguage(new CLanguagePlugin());
  registry.registerLanguage(new CppLanguagePlugin());
  return registry;
};

const createNativeLoadFixture = async () => {
  const metadataStore = new InMemoryMetadataStore();
  const vectorStore = new InMemoryVectorStore({ dimensions: 64 });
  await metadataStore.initialize();
  await vectorStore.initialize();
  await metadataStore.bootstrapStructuredSchema();

  const pluginRegistry = createProductionRegistry();
  const coordinator = createStructuredCoordinator({ metadataStore, vectorStore, pluginRegistry });
  const pipeline = new IndexPipeline({
    metadataStore,
    vectorStore,
    chunker: new Chunker(pluginRegistry),
    embeddingProvider: new TestEmbeddingProvider(),
    pluginRegistry,
    structuredIndexCoordinator: coordinator,
  });

  return { metadataStore, vectorStore, pluginRegistry, coordinator, pipeline };
};

const createEvent = (type: IndexEvent['type'], filePath: string, content: string): IndexEvent => ({
  type,
  filePath,
  contentHash: sha256Hex(new TextEncoder().encode(content)),
  detectedAt: new Date().toISOString(),
});

const createStructuredSource = (filePath: string, language: string, text: string): StructuredSource => {
  const bytes = new TextEncoder().encode(text);
  return { filePath, language, bytes, text: decodeUtf8(bytes) };
};

describe('Node.js 24 native-load smoke test', () => {
  it('requires Node.js >= 24', () => {
    const major = Number(process.versions.node.split('.')[0]);
    expect(major).toBeGreaterThanOrEqual(24);
  });

  it.each(LANGUAGES)(
    'loads the $languageId native grammar and parses a minimal source',
    async ({ plugin, extension, minimalSource }) => {
      const parser = await plugin.createStructuredParser!();
      const source = createStructuredSource(`minimal.${extension}`, plugin.languageId, minimalSource);
      const result = await parser.parseStructured(source);

      expect(result.status).not.toBe('failed');
      expect(result.status).toMatch(/^(ok|degraded)$/);
    },
  );

  it('processes representative files through the production registry and persists structured generations', async () => {
    const { metadataStore, pipeline } = await createNativeLoadFixture();

    const fileContents = new Map<string, string>();
    const events: IndexEvent[] = [];

    for (const { fixtureFilePath, fixturePath } of LANGUAGES) {
      const content = await readFile(fixturePath, 'utf8');
      fileContents.set(fixtureFilePath, content);
      events.push(createEvent('added', fixtureFilePath, content));
    }

    const result = await pipeline.processEvents(events, async (filePath) => fileContents.get(filePath) ?? '');

    expect(result.structuredParseFailures).toHaveLength(0);

    for (const { fixtureFilePath, languageId } of LANGUAGES) {
      const resolution = await metadataStore.resolveFile(fixtureFilePath);
      expect(resolution).toEqual({ kind: 'active', generationId: expect.any(String) });

      const declarations = await metadataStore.getFileDeclarations(fixtureFilePath);
      expect(declarations.length).toBeGreaterThan(0);

      const activeGenerationId = (resolution as { kind: 'active'; generationId: string }).generationId;
      const generation = await metadataStore.getGeneration(fixtureFilePath, activeGenerationId);
      expect(generation).not.toBeNull();
      expect(generation).toMatchObject({
        parserId: languageId,
        schemaVersion: 1,
        fileCompleteness: 'complete',
      });
    }
  });

  it('does not abort a full rebuild when a .cpp file is empty', async () => {
    const { pipeline } = await createNativeLoadFixture();

    const events: IndexEvent[] = [createEvent('added', 'cpp/empty.cpp', '')];
    const result = await pipeline.processEvents(events, async () => '', { fullRebuild: true });

    expect(result.structuredParseFailures).toHaveLength(0);
  });
});
