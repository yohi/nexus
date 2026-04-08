import pLimit from 'p-limit';

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

  // Delete from vector store first
  // Use bounded concurrency to prevent memory/DB overload
  const limit = pLimit(10);
  const deleteTasks = orphanPaths.map((path) =>
    limit(() => vectorStore.deleteByFilePath(path)),
  );
  await Promise.all(deleteTasks);

  // Delete from metadata store (using bulkDeleteMerkleNodes)
  await metadataStore.bulkDeleteMerkleNodes(orphanPaths);

  // Prune empty ancestors
  for (const orphanPath of orphanPaths) {
    await metadataStore.pruneEmptyParents(orphanPath);
  }

  return orphanPaths.length;
};
