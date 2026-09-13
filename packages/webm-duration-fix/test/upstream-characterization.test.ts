import { describe, expect, it } from 'vitest';

import { finalizeWebmBytes, TruncatedDataError } from '../src/index.js';
import { decodeUnsigned } from '../src/bytes.js';
import { WEBM_IDS, type EbmlElement } from '../src/ebml.js';
import { parseWebm } from '../src/parser.js';
import {
  missingDurationFixture,
  multiByteSizesFixture,
  multipleClustersFixture,
  sanitizedRegressionFixture,
  unknownElementsFixture,
  unknownSizeClustersFixture,
  type Fixture,
} from './fixtures.js';

interface Element {
  data?: Uint8Array;
  dataStart: number;
  isEnd?: boolean;
  name: string;
  tagStart: number;
  unknownSize?: boolean;
  value?: number | string;
}

const NAMES = new Map<number, string>([
  [WEBM_IDS.segment, 'Segment'],
  [WEBM_IDS.info, 'Info'],
  [WEBM_IDS.tracks, 'Tracks'],
  [WEBM_IDS.cluster, 'Cluster'],
  [WEBM_IDS.duration, 'Duration'],
  [WEBM_IDS.seekHead, 'SeekHead'],
  [WEBM_IDS.seek, 'Seek'],
  [WEBM_IDS.seekId, 'SeekID'],
  [WEBM_IDS.seekPosition, 'SeekPosition'],
  [WEBM_IDS.cues, 'Cues'],
  [WEBM_IDS.cuePoint, 'CuePoint'],
  [WEBM_IDS.cueTrackPositions, 'CueTrackPositions'],
  [WEBM_IDS.cueClusterPosition, 'CueClusterPosition'],
  [WEBM_IDS.cueTime, 'CueTime'],
  [WEBM_IDS.cueTrack, 'CueTrack'],
  [WEBM_IDS.timecode, 'Timecode'],
  [WEBM_IDS.simpleBlock, 'SimpleBlock'],
  [0x86, 'CodecID'],
  [0x63a2, 'CodecPrivate'],
  [0xb5, 'SamplingFrequency'],
  [0x9f, 'Channels'],
]);

const UNSIGNED_IDS = new Set<number>([
  WEBM_IDS.seekPosition,
  WEBM_IDS.cueClusterPosition,
  WEBM_IDS.cueTime,
  WEBM_IDS.cueTrack,
  WEBM_IDS.timecode,
  0x9f,
]);

function valueOf(element: EbmlElement): number | string | undefined {
  if (UNSIGNED_IDS.has(element.id)) return decodeUnsigned(element.data);
  if (element.id === WEBM_IDS.duration) {
    return new DataView(
      element.data.buffer,
      element.data.byteOffset,
      element.data.byteLength,
    ).getFloat64(0);
  }
  if (element.id === 0x86) return new TextDecoder('ascii').decode(element.data);
  if (element.id === 0xb5) {
    return new DataView(
      element.data.buffer,
      element.data.byteOffset,
      element.data.byteLength,
    ).getFloat64(0);
  }
  return undefined;
}

function flatten(element: EbmlElement, output: Element[]): void {
  const value = valueOf(element);
  const item: Element = {
    data: element.data,
    dataStart: element.dataStart,
    name: NAMES.get(element.id) ?? `0x${element.id.toString(16)}`,
    tagStart: element.tagStart,
    unknownSize: element.unknownSize,
    ...(value === undefined ? {} : { value }),
  };
  output.push(item);
  if (element.children !== undefined) {
    for (const child of element.children) flatten(child, output);
    output.push({ ...item, isEnd: true });
  }
}

function parse(bytes: Uint8Array): Element[] {
  const parsed = parseWebm(bytes);
  const output: Element[] = [];
  flatten(parsed.header, output);
  flatten(parsed.segment, output);
  return output;
}

async function repair(bytes: Uint8Array): Promise<Uint8Array> {
  return (await finalizeWebmBytes(bytes)).bytes;
}

function starts(elements: Element[], name: string): Element[] {
  return elements.filter(
    (element) => element.name === name && element.isEnd !== true,
  );
}

function childValues(
  elements: Element[],
  parentName: string,
  childName: string,
): Element[] {
  const values: Element[] = [];
  let withinParent = false;
  for (const element of elements) {
    if (element.name === parentName) {
      withinParent = element.isEnd !== true;
      continue;
    }
    if (withinParent && element.name === childName) {
      values.push(element);
    }
  }
  return values;
}

function blockPayloads(elements: Element[]): Uint8Array[] {
  return starts(elements, 'SimpleBlock').map((element) => {
    if (element.data === undefined) {
      throw new Error('SimpleBlock was decoded without data.');
    }
    const trackLength = Math.clz32(element.data[0] ?? 0) - 24 + 1;
    return element.data.slice(trackLength + 3);
  });
}

function assertBytesEqual(
  actual: readonly Uint8Array[],
  expected: readonly Uint8Array[],
): void {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((bytes, index) => {
    expect(bytes).toEqual(expected[index]);
  });
}

function containsBytes(haystack: Uint8Array, needle: Uint8Array): boolean {
  return haystack.some((_, offset) =>
    needle.every((byte, index) => haystack[offset + index] === byte),
  );
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(
    '',
  );
}

async function sha256(bytes: Uint8Array): Promise<string> {
  return bytesToHex(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes)),
    ),
  );
}

function assertPreservedMetadata(
  input: Element[],
  output: Element[],
  fixture: Fixture,
): void {
  expect(starts(output, 'CodecID')[0]?.value).toBe('A_OPUS');
  expect(
    Uint8Array.from(starts(output, 'CodecPrivate')[0]?.data ?? []),
  ).toEqual(fixture.codecPrivate);
  expect(starts(output, 'SamplingFrequency')[0]?.value).toBe(48_000);
  expect(starts(output, 'Channels')[0]?.value).toBe(1);
  expect(starts(output, 'CodecID')[0]?.data).toEqual(
    starts(input, 'CodecID')[0]?.data,
  );
  assertBytesEqual(blockPayloads(output), fixture.payloads);
  assertBytesEqual(blockPayloads(output), blockPayloads(input));
}

function assertSeekReferences(elements: Element[]): void {
  const segment = starts(elements, 'Segment')[0];
  if (segment === undefined) {
    throw new Error('Repaired output has no Segment.');
  }
  const actualStarts = new Map(
    ['Info', 'Tracks', 'Cues'].map((name) => [
      name,
      (starts(elements, name)[0]?.tagStart ?? -1) - segment.dataStart,
    ]),
  );
  const seekIds = childValues(elements, 'Seek', 'SeekID');
  const seekPositions = childValues(elements, 'Seek', 'SeekPosition');
  const namesById = new Map([
    ['1549a966', 'Info'],
    ['1654ae6b', 'Tracks'],
    ['1c53bb6b', 'Cues'],
  ]);

  expect(seekIds).toHaveLength(3);
  expect(seekPositions).toHaveLength(3);
  seekIds.forEach((seekId, index) => {
    const hex = bytesToHex(seekId.data ?? new Uint8Array());
    const target = namesById.get(hex);
    expect(target).toBeDefined();
    expect(seekPositions[index]?.value).toBe(actualStarts.get(target ?? ''));
  });

  const clusters = starts(elements, 'Cluster');
  const cuePositions = starts(elements, 'CueClusterPosition');
  const cueTimes = starts(elements, 'CueTime');
  expect(cuePositions).toHaveLength(clusters.length);
  cuePositions.forEach((position, index) => {
    expect(position.value).toBe(
      (clusters[index]?.tagStart ?? -1) - segment.dataStart,
    );
  });
  expect(cueTimes.map(({ value }) => value)).toEqual(
    starts(elements, 'Timecode').map(({ value }) => value),
  );
}

async function assertCharacterizedRepair(
  fixture: Fixture,
): Promise<Uint8Array> {
  const input = parse(fixture.bytes);
  const outputBytes = await repair(fixture.bytes);
  const output = parse(outputBytes);
  const duration = starts(output, 'Duration');

  expect(duration).toHaveLength(1);
  expect(duration[0]?.value).toBe(fixture.expectedDuration);
  expect(Number.isFinite(duration[0]?.value)).toBe(true);
  expect(starts(output, 'SeekHead')).toHaveLength(1);
  expect(starts(output, 'Cues')).toHaveLength(1);
  assertSeekReferences(output);
  assertPreservedMetadata(input, output, fixture);

  // Upstream finalizes seek metadata but deliberately retains its fixed
  // unknown-size Segment encoding; Task 4 must not accidentally change that.
  expect(starts(output, 'Segment')[0]?.unknownSize).toBe(true);
  return outputBytes;
}

describe('webm-duration-fix v1.0.4 upstream characterization', () => {
  it('repairs a streaming WebM with no Duration', async () => {
    const fixture = missingDurationFixture();
    expect(starts(parse(fixture.bytes), 'Duration')).toHaveLength(0);
    await assertCharacterizedRepair(fixture);
  });

  it('creates valid cues for every cluster and preserves every audio payload', async () => {
    const fixture = multipleClustersFixture();
    expect(starts(parse(fixture.bytes), 'Cluster')).toHaveLength(2);
    await assertCharacterizedRepair(fixture);
  });

  it('handles multi-byte element sizes without changing large metadata or blocks', async () => {
    const fixture = multiByteSizesFixture();
    expect(fixture.codecPrivate.length).toBeGreaterThan(127);
    expect(fixture.payloads.every((payload) => payload.length > 127)).toBe(
      true,
    );
    await assertCharacterizedRepair(fixture);
  });

  it('preserves opaque metadata elements byte-for-byte', async () => {
    const fixture = unknownElementsFixture();
    const output = await assertCharacterizedRepair(fixture);
    for (const element of fixture.preservedElements ?? []) {
      expect(containsBytes(output, element)).toBe(true);
    }
  });

  it('recognizes consecutive unknown-size streaming Clusters', async () => {
    const fixture = unknownSizeClustersFixture();
    const output = await assertCharacterizedRepair(fixture);
    expect(starts(parse(output), 'Cluster')).toHaveLength(2);
  });

  it('matches the sanitized 20,818-timecode regression semantics', async () => {
    const fixture = sanitizedRegressionFixture();
    const input = parse(fixture.bytes);
    expect(starts(input, 'Duration')[0]?.value).toBe(0);
    expect(starts(input, 'SeekHead')).toHaveLength(0);
    expect(starts(input, 'Cues')).toHaveLength(0);

    const output = await assertCharacterizedRepair(fixture);
    expect(await sha256(output)).toBe(
      'e5b1b1999272d04493de28326b30571ad50f78c6988db596d19036f9776b937d',
    );
  });

  it('is byte-idempotent once its own finalized representation is valid', async () => {
    const alreadyFinalizedFixture = await repair(
      multipleClustersFixture().bytes,
    );
    const twice = await repair(alreadyFinalizedFixture);
    expect(twice).toEqual(alreadyFinalizedFixture);
  });

  it('rejects malformed and truncated streams explicitly', async () => {
    await expect(repair(Uint8Array.of(0))).rejects.toMatchObject({
      code: 'invalid-ebml',
    });

    const valid = missingDurationFixture().bytes;
    const truncated = valid.slice(0, -8);
    await expect(repair(truncated)).rejects.toBeInstanceOf(TruncatedDataError);
  });
});
