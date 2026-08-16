import {
  createContributionRequestSchema,
  editContributionRequestSchema,
  journalDayViewSchema,
  type ContributionResource,
  type CreateContributionRequest,
  type JournalDayView,
} from '@journal/contracts';
import { computed, readonly, ref } from 'vue';

import {
  createContribution,
  createUuidV7,
  editContributionAtRevision,
  getContribution,
  getJournalDay,
  JournalApiError,
} from './api';
import { browserMetadata, type JournalIndexedDb } from '../storage/indexed-db';

const CACHE_SCHEMA_VERSION = 1 as const;
const PBKDF2_ITERATIONS = 600_000;
const CACHE_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_CACHED_DAYS = 200;
const FALLBACK_CACHE_BUDGET = 100 * 1024 * 1024;
const MAX_CACHE_BUDGET = 250 * 1024 * 1024;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

interface CreateMutation {
  kind: 'create';
  input: CreateContributionRequest;
  idempotencyKey: string;
}

interface EditMutation {
  kind: 'edit';
  contributionId: string;
  journalDate: string;
  baseRevision: number;
  revisionId: string;
  text: string;
  editReason?: string;
  idempotencyKey: string;
}

export type TextMutation = CreateMutation | EditMutation;

export interface OfflineConflict {
  readonly outboxId: string;
  readonly current: ContributionResource;
  readonly draft: string;
  readonly reason: string;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 1)
    binary += String.fromCharCode(bytes[index] ?? 0);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1)
    bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function aad(
  ownerId: string,
  kind: string,
  stableId: string,
): Uint8Array<ArrayBuffer> {
  return new Uint8Array(
    textEncoder.encode(
      `${ownerId}\u0000${kind}\u0000${stableId}\u0000${CACHE_SCHEMA_VERSION}`,
    ),
  );
}

async function deriveWrappingKey(
  secret: string,
  salt: Uint8Array<ArrayBuffer>,
  iterations: number,
): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    'raw',
    textEncoder.encode(secret),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

async function encrypt(
  key: CryptoKey,
  ownerId: string,
  kind: string,
  stableId: string,
  value: unknown,
): Promise<{ nonce: string; ciphertext: string; byteSize: number }> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = textEncoder.encode(JSON.stringify(value));
  const encrypted = new Uint8Array(
    await crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv: nonce,
        additionalData: aad(ownerId, kind, stableId),
      },
      key,
      plaintext,
    ),
  );
  return {
    nonce: bytesToBase64(nonce),
    ciphertext: bytesToBase64(encrypted),
    byteSize: encrypted.byteLength,
  };
}

async function decrypt<T>(
  key: CryptoKey,
  ownerId: string,
  kind: string,
  stableId: string,
  nonce: string,
  ciphertext: string,
): Promise<T> {
  const plaintext = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: base64ToBytes(nonce),
      additionalData: aad(ownerId, kind, stableId),
    },
    key,
    base64ToBytes(ciphertext),
  );
  return JSON.parse(textDecoder.decode(plaintext)) as T;
}

function quotaExceeded(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'QuotaExceededError';
}

export class OfflineJournal {
  readonly #storage: JournalIndexedDb;
  readonly #iterations: number;
  #ownerId: string | undefined;
  #key: CryptoKey | undefined;
  #syncing: Promise<void> | undefined;
  #lastSequence = 0;
  readonly configured = ref(false);
  readonly unlocked = ref(false);
  readonly pendingCount = ref(0);
  readonly cacheBytes = ref(0);
  readonly cacheDays = ref(0);
  readonly lastReadFromCache = ref(false);
  readonly conflict = ref<OfflineConflict>();
  readonly captureError = ref('');

  constructor(storage = browserMetadata, iterations = PBKDF2_ITERATIONS) {
    this.#storage = storage;
    this.#iterations = iterations;
  }

  async initialize(ownerId: string): Promise<void> {
    if (this.#ownerId !== ownerId) this.lock();
    this.#ownerId = ownerId;
    this.configured.value =
      (await this.#storage.getOfflineConfig(ownerId)) !== undefined;
    await this.#refreshUsage();
  }

  async setup(secret: string): Promise<void> {
    const ownerId = this.#requireOwner();
    if (secret.length < 8)
      throw new Error('Use at least 8 characters for the local unlock secret.');
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const wrappingKey = await deriveWrappingKey(secret, salt, this.#iterations);
    const dataKey = await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt'],
    );
    const rawDataKey = new Uint8Array(
      await crypto.subtle.exportKey('raw', dataKey),
    );
    const wrapped = await encrypt(
      wrappingKey,
      ownerId,
      'data-key',
      ownerId,
      bytesToBase64(rawDataKey),
    );
    await this.#storage.putOfflineConfig({
      ownerId,
      salt: bytesToBase64(salt),
      iterations: this.#iterations,
      wrappedKeyNonce: wrapped.nonce,
      wrappedKey: wrapped.ciphertext,
    });
    this.#key = dataKey;
    this.configured.value = true;
    this.unlocked.value = true;
  }

  async unlock(secret: string): Promise<void> {
    const ownerId = this.#requireOwner();
    const configuration = await this.#storage.getOfflineConfig(ownerId);
    if (configuration === undefined)
      throw new Error('Offline storage has not been enabled.');
    try {
      const wrappingKey = await deriveWrappingKey(
        secret,
        base64ToBytes(configuration.salt),
        configuration.iterations,
      );
      const encodedKey = await decrypt<string>(
        wrappingKey,
        ownerId,
        'data-key',
        ownerId,
        configuration.wrappedKeyNonce,
        configuration.wrappedKey,
      );
      this.#key = await crypto.subtle.importKey(
        'raw',
        base64ToBytes(encodedKey),
        { name: 'AES-GCM' },
        false,
        ['encrypt', 'decrypt'],
      );
      this.unlocked.value = true;
      await this.#refreshUsage();
    } catch {
      this.#key = undefined;
      this.unlocked.value = false;
      throw new Error('The local unlock secret is incorrect.');
    }
  }

  lock(): void {
    this.#key = undefined;
    this.unlocked.value = false;
    this.conflict.value = undefined;
    this.lastReadFromCache.value = false;
  }

  async clearReadCache(): Promise<void> {
    const ownerId = this.#requireOwner();
    await this.#storage.clearJournalCache(ownerId);
    await this.#refreshUsage();
  }

  async logout(): Promise<void> {
    if (this.#ownerId !== undefined)
      await this.#storage.clearJournalCache(this.#ownerId);
    this.lock();
    this.cacheBytes.value = 0;
    this.cacheDays.value = 0;
  }

  async enqueueCreate(
    input: CreateContributionRequest,
    idempotencyKey: string,
  ): Promise<void> {
    const parsed = createContributionRequestSchema.parse(input);
    await this.#enqueue(
      {
        kind: 'create',
        input: parsed,
        idempotencyKey,
      },
      parsed.contributionId,
    );
  }

  async enqueueEdit(input: Omit<EditMutation, 'kind'>): Promise<void> {
    editContributionRequestSchema.parse({
      revisionId: input.revisionId,
      text: input.text,
      ...(input.editReason === undefined
        ? {}
        : { editReason: input.editReason }),
    });
    await this.#enqueue({ kind: 'edit', ...input }, input.contributionId);
  }

  async replay(csrfToken: string): Promise<void> {
    if (!this.unlocked.value || !navigator.onLine) return;
    if (this.#syncing !== undefined) return this.#syncing;
    this.#syncing = this.#replayInOrder(csrfToken).finally(() => {
      this.#syncing = undefined;
    });
    return this.#syncing;
  }

  async resolveConflict(csrfToken: string, useDraft: boolean): Promise<void> {
    const conflict = this.conflict.value;
    if (conflict === undefined) return;
    if (useDraft) {
      const revision = conflict.current.currentRevision?.revision;
      if (revision === undefined)
        throw new Error('The latest revision is missing.');
      await this.enqueueEdit({
        contributionId: conflict.current.id,
        journalDate: conflict.current.journalDate,
        baseRevision: revision,
        revisionId: createUuidV7(),
        text: conflict.draft,
        ...(conflict.reason === '' ? {} : { editReason: conflict.reason }),
        idempotencyKey: `edit-${createUuidV7()}`,
      });
    }
    await this.#storage.deleteOutbox(conflict.outboxId);
    this.conflict.value = undefined;
    await this.#refreshUsage();
    if (useDraft) await this.replay(csrfToken);
  }

  async readDay(journalDate: string): Promise<JournalDayView | undefined> {
    const ownerId = this.#requireOwner();
    if (navigator.onLine) {
      try {
        const day = await getJournalDay(journalDate);
        this.lastReadFromCache.value = false;
        if (day !== undefined && this.unlocked.value) await this.#cacheDay(day);
        return day;
      } catch (error) {
        if (error instanceof JournalApiError) {
          if (error.status === 401) this.lock();
          throw error;
        }
      }
    }
    const key = this.#requireKey();
    const record = await this.#storage.getJournalCache(ownerId, journalDate);
    if (record === undefined)
      throw new Error(
        'This Journal Day is not available in the offline cache.',
      );
    if (Date.now() - Date.parse(record.refreshedAt) > CACHE_EXPIRY_MS) {
      await this.#storage.deleteJournalCache(record.key);
      await this.#refreshUsage();
      throw new Error(
        'This cached Journal Day has expired. Connect to refresh it.',
      );
    }
    const day = journalDayViewSchema.parse(
      await decrypt<unknown>(
        key,
        ownerId,
        'journal-day',
        journalDate,
        record.nonce,
        record.ciphertext,
      ),
    );
    await this.#storage.putJournalCache({
      ...record,
      lastAccessedAt: new Date().toISOString(),
    });
    this.lastReadFromCache.value = true;
    return day;
  }

  async pendingForDay(journalDate: string): Promise<TextMutation[]> {
    if (!this.unlocked.value) return [];
    const ownerId = this.#requireOwner();
    const key = this.#requireKey();
    const result: TextMutation[] = [];
    for (const record of await this.#storage.listOutbox(ownerId)) {
      const mutation = await decrypt<TextMutation>(
        key,
        ownerId,
        `outbox-${record.kind}`,
        record.stableId,
        record.nonce,
        record.ciphertext,
      );
      if (
        (mutation.kind === 'create'
          ? mutation.input.journalDate
          : mutation.journalDate) === journalDate
      )
        result.push(mutation);
    }
    return result;
  }

  async #enqueue(mutation: TextMutation, stableId: string): Promise<void> {
    const ownerId = this.#requireOwner();
    const key = this.#requireKey();
    const id = mutation.idempotencyKey;
    const encrypted = await encrypt(
      key,
      ownerId,
      `outbox-${mutation.kind}`,
      stableId,
      mutation,
    );
    const now = Date.now();
    this.#lastSequence = Math.max(now * 1000, this.#lastSequence + 1);
    try {
      await this.#storage.putOutbox({
        id,
        ownerId,
        kind: mutation.kind,
        stableId,
        schemaVersion: CACHE_SCHEMA_VERSION,
        createdAt: new Date(now).toISOString(),
        sequence: this.#lastSequence,
        nonce: encrypted.nonce,
        ciphertext: encrypted.ciphertext,
        state: 'pending',
      });
      this.captureError.value = '';
      await this.#refreshUsage();
    } catch (error) {
      this.captureError.value = quotaExceeded(error)
        ? 'Local storage is full. Cached reads were cleared; retry this capture.'
        : 'The note could not be saved locally.';
      if (quotaExceeded(error)) await this.clearReadCache();
      throw new Error(this.captureError.value, { cause: error });
    }
  }

  async #replayInOrder(csrfToken: string): Promise<void> {
    const ownerId = this.#requireOwner();
    const key = this.#requireKey();
    for (const record of await this.#storage.listOutbox(ownerId)) {
      if (!navigator.onLine) break;
      const mutation = await decrypt<TextMutation>(
        key,
        ownerId,
        `outbox-${record.kind}`,
        record.stableId,
        record.nonce,
        record.ciphertext,
      );
      try {
        if (mutation.kind === 'create') {
          await createContribution(
            mutation.input,
            csrfToken,
            mutation.idempotencyKey,
          );
        } else {
          await editContributionAtRevision(
            mutation.contributionId,
            mutation.baseRevision,
            mutation.text,
            mutation.editReason,
            mutation.revisionId,
            csrfToken,
            mutation.idempotencyKey,
          );
        }
        await this.#storage.deleteOutbox(record.id);
      } catch (error) {
        if (error instanceof JournalApiError && error.status === 401)
          this.lock();
        if (
          mutation.kind === 'edit' &&
          error instanceof JournalApiError &&
          error.code === 'etag_mismatch'
        ) {
          const current = await getContribution(mutation.contributionId);
          await this.#storage.putOutbox({ ...record, state: 'conflict' });
          this.conflict.value = {
            outboxId: record.id,
            current,
            draft: mutation.text,
            reason: mutation.editReason ?? '',
          };
        }
        break;
      }
    }
    await this.#refreshUsage();
  }

  async #cacheDay(day: JournalDayView): Promise<void> {
    const ownerId = this.#requireOwner();
    const key = this.#requireKey();
    const encrypted = await encrypt(
      key,
      ownerId,
      'journal-day',
      day.journalDate,
      day,
    );
    const now = new Date().toISOString();
    await this.#storage.putJournalCache({
      key: `${ownerId}:${day.journalDate}`,
      ownerId,
      stableId: day.journalDate,
      schemaVersion: CACHE_SCHEMA_VERSION,
      refreshedAt: now,
      lastAccessedAt: now,
      byteSize: encrypted.byteSize,
      nonce: encrypted.nonce,
      ciphertext: encrypted.ciphertext,
    });
    await this.#enforceCacheBounds();
  }

  async #enforceCacheBounds(): Promise<void> {
    const ownerId = this.#requireOwner();
    const records = await this.#storage.listJournalCache(ownerId);
    const estimate = await navigator.storage?.estimate?.();
    const budget = estimate?.quota
      ? Math.min(MAX_CACHE_BUDGET, Math.floor(estimate.quota * 0.1))
      : FALLBACK_CACHE_BUDGET;
    let bytes = records.reduce((sum, record) => sum + record.byteSize, 0);
    let count = records.length;
    for (const record of records) {
      const expired =
        Date.now() - Date.parse(record.refreshedAt) > CACHE_EXPIRY_MS;
      if (!expired && count <= MAX_CACHED_DAYS && bytes <= budget) continue;
      await this.#storage.deleteJournalCache(record.key);
      bytes -= record.byteSize;
      count -= 1;
    }
    this.cacheBytes.value = bytes;
    this.cacheDays.value = count;
  }

  async #refreshUsage(): Promise<void> {
    if (this.#ownerId === undefined) return;
    const [outbox, cache] = await Promise.all([
      this.#storage.listOutbox(this.#ownerId),
      this.#storage.listJournalCache(this.#ownerId),
    ]);
    this.pendingCount.value = outbox.length;
    this.#lastSequence = Math.max(
      this.#lastSequence,
      ...outbox.map((record) => record.sequence),
    );
    this.cacheDays.value = cache.length;
    this.cacheBytes.value = cache.reduce(
      (sum, record) => sum + record.byteSize,
      0,
    );
  }

  #requireOwner(): string {
    if (this.#ownerId === undefined)
      throw new Error('An authenticated owner is required.');
    return this.#ownerId;
  }

  #requireKey(): CryptoKey {
    if (this.#key === undefined)
      throw new Error(
        'Unlock offline storage before saving or reading local data.',
      );
    return this.#key;
  }
}

const offlineJournal = new OfflineJournal();

export function useOfflineJournal() {
  return {
    configured: readonly(offlineJournal.configured),
    unlocked: readonly(offlineJournal.unlocked),
    pendingCount: readonly(offlineJournal.pendingCount),
    cacheBytes: readonly(offlineJournal.cacheBytes),
    cacheDays: readonly(offlineJournal.cacheDays),
    lastReadFromCache: readonly(offlineJournal.lastReadFromCache),
    conflict: readonly(offlineJournal.conflict),
    captureError: readonly(offlineJournal.captureError),
    readyForLocalCapture: computed(() => offlineJournal.unlocked.value),
    initialize: (ownerId: string) => offlineJournal.initialize(ownerId),
    setup: (secret: string) => offlineJournal.setup(secret),
    unlock: (secret: string) => offlineJournal.unlock(secret),
    lock: () => offlineJournal.lock(),
    logout: () => offlineJournal.logout(),
    clearReadCache: () => offlineJournal.clearReadCache(),
    enqueueCreate: (input: CreateContributionRequest, idempotencyKey: string) =>
      offlineJournal.enqueueCreate(input, idempotencyKey),
    enqueueEdit: (input: Omit<EditMutation, 'kind'>) =>
      offlineJournal.enqueueEdit(input),
    replay: (csrfToken: string) => offlineJournal.replay(csrfToken),
    resolveConflict: (csrfToken: string, useDraft: boolean) =>
      offlineJournal.resolveConflict(csrfToken, useDraft),
    readDay: (journalDate: string) => offlineJournal.readDay(journalDate),
    pendingForDay: (journalDate: string) =>
      offlineJournal.pendingForDay(journalDate),
  };
}
