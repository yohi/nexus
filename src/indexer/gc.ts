import type { IMetadataStore, IVectorStore } from '../types/index.js';

export const gcOrphanNodes = async (
  metadataStore: IMetadataStore,
  vectorStore: IVectorStore,
  pathExists: (targetPath: string) => Promise<boolean>,
): Promise<number> => {
  const fileNodes = await metadataStore.getAllFileNodes();
  const orphanPaths: string[] = [];

  for (const node of fileNodes) {
    if (!(await pathExists(node.path))) {
      orphanPaths.push(node.path);
    }
  }

  if (orphanPaths.length === 0) {
    return 0;
  }

  // Delete from vector store first, then metadata
  await Promise.all(orphanPaths.map((path) => vectorStore.deleteByFilePath(path)));
  await metadataStore.bulkDeleteMerkleNodes(orphanPaths);

  return orphanPaths.length;
};
