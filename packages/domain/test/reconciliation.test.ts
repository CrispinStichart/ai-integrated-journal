import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  DomainInvariantError,
  planReconciliation,
  processorReconciliationCandidates,
  reconciliationPayloadCanonical,
} from '../src/index.js';

describe('processor reconciliation (ARCH-004, PROC-005, STATE-004, STATE-005, EDIT-005, EDIT-006)', () => {
  it('creates, updates, supersedes, removes, and leaves exact matches unchanged by stable logical key', () => {
    const candidate = (logicalKey: string, value: number) => {
      const payload = { logicalKey, value };
      return {
        logicalKey: `string:${logicalKey}`,
        payload,
        payloadHash: reconciliationPayloadCanonical(payload),
      };
    };
    const current = [
      {
        artifactId: 'artifact-a',
        versionId: 'version-a',
        logicalKey: 'string:a',
        payload: { logicalKey: 'a', value: 1 },
        payloadHash: reconciliationPayloadCanonical({
          logicalKey: 'a',
          value: 1,
        }),
        processorVersionId: 'processor-version-current',
        authority: 'generated' as const,
      },
      {
        artifactId: 'artifact-b',
        versionId: 'version-b',
        logicalKey: 'string:b',
        payload: { logicalKey: 'b', value: 1 },
        payloadHash: reconciliationPayloadCanonical({
          logicalKey: 'b',
          value: 1,
        }),
        processorVersionId: 'processor-version-old',
        authority: 'generated' as const,
      },
      {
        artifactId: 'artifact-c',
        versionId: 'version-c',
        logicalKey: 'string:c',
        payload: { logicalKey: 'c', value: 1 },
        payloadHash: reconciliationPayloadCanonical({
          logicalKey: 'c',
          value: 1,
        }),
        processorVersionId: 'processor-version-current',
        authority: 'generated' as const,
      },
      {
        artifactId: 'artifact-d',
        versionId: 'version-d',
        logicalKey: 'string:d',
        payload: { logicalKey: 'd', value: 1 },
        payloadHash: reconciliationPayloadCanonical({
          logicalKey: 'd',
          value: 1,
        }),
        processorVersionId: 'processor-version-current',
        authority: 'generated' as const,
      },
    ];
    expect(
      planReconciliation({
        strategy: 'logical_key',
        completeness: 'complete',
        processorVersionId: 'processor-version-current',
        candidates: [
          candidate('a', 1),
          candidate('b', 2),
          candidate('c', 2),
          candidate('e', 1),
        ],
        current,
      }).map(({ logicalKey, outcome }) => [logicalKey, outcome]),
    ).toEqual([
      ['string:a', 'unchanged'],
      ['string:b', 'supersede'],
      ['string:c', 'update'],
      ['string:e', 'create'],
      ['string:d', 'remove_supersede'],
    ]);
  });

  it('[ARCH-004][EDIT-006] never replaces or removes manual authority', () => {
    const payload = { logicalKey: 'manual', value: 'generated proposal' };
    const outcomes = planReconciliation({
      strategy: 'logical_key',
      completeness: 'complete',
      processorVersionId: 'new',
      candidates: [
        {
          logicalKey: 'string:manual',
          payload,
          payloadHash: reconciliationPayloadCanonical(payload),
        },
      ],
      current: [
        {
          artifactId: 'artifact',
          versionId: 'version',
          logicalKey: 'string:manual',
          payload: { logicalKey: 'manual', value: 'human value' },
          payloadHash: reconciliationPayloadCanonical({
            logicalKey: 'manual',
            value: 'human value',
          }),
          processorVersionId: 'old',
          authority: 'manual',
        },
        {
          artifactId: 'removed-manual',
          versionId: 'removed-version',
          logicalKey: 'string:absent',
          payload: { logicalKey: 'absent' },
          payloadHash: reconciliationPayloadCanonical({ logicalKey: 'absent' }),
          processorVersionId: 'old',
          authority: 'manual',
        },
      ],
    });
    expect(outcomes.map(({ outcome }) => outcome)).toEqual([
      'unchanged',
      'unchanged',
    ]);
  });

  it('[STATE-005] does not treat omitted items in partial output as removed', () => {
    expect(
      planReconciliation({
        strategy: 'logical_key',
        completeness: 'partial',
        processorVersionId: 'version',
        candidates: [],
        current: [
          {
            artifactId: 'artifact',
            versionId: 'version',
            logicalKey: 'string:a',
            payload: { logicalKey: 'a' },
            payloadHash: reconciliationPayloadCanonical({ logicalKey: 'a' }),
            processorVersionId: 'version',
            authority: 'generated',
          },
        ],
      }),
    ).toEqual([]);
  });

  it('rejects missing, invalid, and duplicate logical keys rather than deriving unstable identities', () => {
    const hashPayload = reconciliationPayloadCanonical;
    expect(() =>
      processorReconciliationCandidates({
        strategy: 'logical_key',
        payload: { items: [] },
        hashPayload,
      }),
    ).toThrow(DomainInvariantError);
    expect(() =>
      processorReconciliationCandidates({
        strategy: 'logical_key',
        logicalKey: 'logicalKey',
        payload: { items: [{}] },
        hashPayload,
      }),
    ).toThrow(DomainInvariantError);
    expect(() =>
      processorReconciliationCandidates({
        strategy: 'logical_key',
        logicalKey: 'logicalKey',
        payload: { items: [{ logicalKey: 'x' }, { logicalKey: 'x' }] },
        hashPayload,
      }),
    ).toThrow(/duplicate/);
    for (const logicalKey of [
      '',
      Number.POSITIVE_INFINITY,
      {},
      'x'.repeat(250),
    ]) {
      expect(() =>
        processorReconciliationCandidates({
          strategy: 'logical_key',
          logicalKey: 'logicalKey',
          payload: { items: [{ logicalKey }] },
          hashPayload,
        }),
      ).toThrow(DomainInvariantError);
    }
    expect(() =>
      processorReconciliationCandidates({
        strategy: 'logical_key',
        logicalKey: 'logicalKey',
        payload: { items: ['not-an-object'] },
        hashPayload,
      }),
    ).toThrow(/must be an object/);
  });

  it('uses type-tagged scalar keys and strategy-stable scope or append identities', () => {
    const logical = processorReconciliationCandidates({
      strategy: 'logical_key',
      logicalKey: 'logicalKey',
      payload: {
        items: [{ logicalKey: true }, { logicalKey: 1 }, { logicalKey: '1' }],
      },
      hashPayload: reconciliationPayloadCanonical,
    });
    expect(logical.map(({ logicalKey }) => logicalKey)).toEqual([
      'boolean:true',
      'number:1',
      'string:1',
    ]);
    expect(
      processorReconciliationCandidates({
        strategy: 'replace_scope',
        payload: { value: 1 },
        hashPayload: reconciliationPayloadCanonical,
      })[0]?.logicalKey,
    ).toBe('scope');
    expect(
      processorReconciliationCandidates({
        strategy: 'append_only',
        payload: { value: 1 },
        hashPayload: () => 'a'.repeat(64),
      })[0]?.logicalKey,
    ).toBe(`payload:${'a'.repeat(64)}`);
  });

  it('append-only reconciliation never removes prior artifacts', () => {
    expect(
      planReconciliation({
        strategy: 'append_only',
        completeness: 'complete',
        processorVersionId: 'version',
        candidates: [],
        current: [
          {
            artifactId: 'artifact',
            versionId: 'version',
            logicalKey: 'payload:old',
            payload: { value: 'old' },
            payloadHash: 'old',
            processorVersionId: 'version',
            authority: 'generated',
          },
        ],
      }),
    ).toEqual([]);
  });

  it('property: planning the same complete state twice is idempotently unchanged', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.stringMatching(/^[a-z]{1,12}$/), {
          maxLength: 20,
        }),
        (keys) => {
          const candidates = processorReconciliationCandidates({
            strategy: 'logical_key',
            logicalKey: 'logicalKey',
            payload: {
              items: keys.map((logicalKey) => ({
                logicalKey,
                value: logicalKey.length,
              })),
            },
            hashPayload: reconciliationPayloadCanonical,
          });
          const current = candidates.map((candidate, index) => ({
            artifactId: `artifact-${index}`,
            versionId: `version-${index}`,
            logicalKey: candidate.logicalKey,
            payload: candidate.payload,
            payloadHash: candidate.payloadHash,
            processorVersionId: 'processor-version',
            authority: 'generated' as const,
          }));
          expect(
            planReconciliation({
              strategy: 'logical_key',
              completeness: 'complete',
              processorVersionId: 'processor-version',
              candidates,
              current,
            }).every(({ outcome }) => outcome === 'unchanged'),
          ).toBe(true);
        },
      ),
    );
  });
});
