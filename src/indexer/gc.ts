import type { IMetadataStore, IVectorStore } from '../types/index.js';

export const gcOrphanNodes = async (
  metadataStore: IMetadataStore,
  vectorStore: IVectorStore,
  pathExists: (targetPath: string) => Promise<boolean>,
): Promise<number> => {
  const nodes = await metadataStore.getAllNodes();
  const orphanPaths: string[] = [];

  for (const node of nodes) {
    if (!(await pathExists(node.path))) {
      orphanPaths.push(node.path);
    }
  }

  if (orphanPaths.length === 0) {
    return 0;
  }

  // Delete from vector store first (by prefix to handle subtrees)
  await Promise.all(orphanPaths.map((path) => vectorStore.deleteByPathPrefix(path)));

  // Delete from metadata store (using bulkDeleteSubtrees)
  await metadataStore.bulkDeleteSubtrees(orphanPaths);

  // Prune empty ancestors
  for (const orphanPath of orphanPaths) {
    await metadataStore.pruneEmptyParents(orphanPath);
  }

  return orphanPaths.length;
};
