import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import fixWebmDuration from '../src/upstream/index.js';
import Decoder from '../src/upstream/ebml/EBMLDecoder.js';
import { ebmlBlock } from '../src/upstream/ebml/tools.js';
import {
  missingDurationFixture,
  multiByteSizesFixture,
  multipleClustersFixture,
  sanitizedRegressionFixture,
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

const WEBM_TYPE = 'audio/webm;codecs=opus';

function parse(bytes: Uint8Array): Element[] {
  return new Decoder().decode(
    bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer,
  ) as Element[];
}

async function repair(bytes: Uint8Array): Promise<Uint8Array> {
  const input = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  const repaired = await fixWebmDuration(
    new Blob([input], { type: WEBM_TYPE }),
  );
  expect(repaired.type).toBe(WEBM_TYPE);
  return new Uint8Array(await repaired.arrayBuffer());
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
    const frame = ebmlBlock(Buffer.from(element.data)).frames[0];
    if (frame === undefined) {
      throw new Error('SimpleBlock was decoded without a frame.');
    }
    return Uint8Array.from(frame);
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
    const hex = Buffer.from(seekId.data ?? []).toString('hex');
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

  it('matches the sanitized 20,818-timecode regression semantics', async () => {
    const fixture = sanitizedRegressionFixture();
    const input = parse(fixture.bytes);
    expect(starts(input, 'Duration')[0]?.value).toBe(0);
    expect(starts(input, 'SeekHead')).toHaveLength(0);
    expect(starts(input, 'Cues')).toHaveLength(0);

    const output = await assertCharacterizedRepair(fixture);
    expect(createHash('sha256').update(output).digest('hex')).toBe(
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

  it('rejects malformed input but currently rewrites a truncated stream', async () => {
    await expect(repair(Uint8Array.of(0))).rejects.toThrow(
      'Unrepresentable length',
    );

    const valid = missingDurationFixture().bytes;
    const truncated = valid.slice(0, -8);
    const rewritten = await repair(truncated);
    expect(blockPayloads(parse(rewritten))).toHaveLength(1);
    expect(rewritten.slice(-12)).toEqual(truncated.slice(-12));
  });
});
