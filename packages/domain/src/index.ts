/** Framework-free domain primitives shared by every application tier. */
export const domainPackageName = '@journal/domain' as const;

export * from './audit.js';
export * from './artifact-editing.js';
export * from './authority.js';
export * from './deletion.js';
export * from './evidence.js';
export * from './errors.js';
export * from './identity.js';
export * from './journal.js';
export * from './memory.js';
export * from './nudges.js';
export * from './processing-lifecycle.js';
export * from './reconciliation.js';
export * from './reprocessing.js';
export * from './revision.js';
export * from './semantic-value.js';
export * from './temporal.js';
