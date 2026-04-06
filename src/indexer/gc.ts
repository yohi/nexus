import type { IMetadataStore } from '../types/index.js';

export const gcOrphanNodes = async (
  metadataStore: IMetadataStore,
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

  await metadataStore.bulkDeleteMerkleNodes(orphanPaths);
  return orphanPaths.length;
};
