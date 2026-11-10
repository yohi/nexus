// Shared internal contract for storage ownership (Nexus #297, Design §4.4). Not a public API.
export type CanonicalPath = string & { readonly __canonicalPath: unique symbol };

export type PersistentTarget = Readonly<{ kind: 'persistent'; path: CanonicalPath }>;

export type VectorTarget = PersistentTarget | Readonly<{ kind: 'ephemeral'; source: 'memory://' }>;

export interface ResolvedStorageOwnershipTargets {
  readonly ownerProjectRoot: CanonicalPath;
  readonly rootDir: PersistentTarget;
  readonly metadataDbPath: PersistentTarget;
  readonly vectorDbPath: VectorTarget;
}

export type OwnershipPreflight = Readonly<{
  targets: ResolvedStorageOwnershipTargets;
  disposition: 'owned' | 'unclaimed-clean' | 'refuse';
  reason?: string;
}>;
