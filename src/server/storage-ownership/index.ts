export { resolveStorageOwnershipTargets, storageTargetsFingerprint } from './targets.js';
export { inspectStorageOwnership } from './preflight.js';
export * from './claim-format.js';
export {
  admitStorageWriter, assertLiveWriterAdmission, consumeWriterAdmission, storageOwnershipAdmissionService,
  StorageOwnershipError,
} from './admission.js';
export type {
  ConsumedWriterLease, StorageOwnershipAdmissionService, StorageOwnershipErrorCode, WriterAdmission,
} from './admission.js';
export type {
  CanonicalPath, OwnershipPreflight, PersistentTarget, ResolvedStorageOwnershipTargets, VectorTarget,
} from './types.js';
