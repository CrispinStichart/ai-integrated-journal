const IDS = {
  audio: [0xe1],
  channels: [0x9f],
  cluster: [0x1f, 0x43, 0xb6, 0x75],
  codecId: [0x86],
  codecPrivate: [0x63, 0xa2],
  docType: [0x42, 0x82],
  duration: [0x44, 0x89],
  ebml: [0x1a, 0x45, 0xdf, 0xa3],
  info: [0x15, 0x49, 0xa9, 0x66],
  samplingFrequency: [0xb5],
  segment: [0x18, 0x53, 0x80, 0x67],
  simpleBlock: [0xa3],
  timecode: [0xe7],
  timecodeScale: [0x2a, 0xd7, 0xb1],
  trackEntry: [0xae],
  trackNumber: [0xd7],
  tracks: [0x16, 0x54, 0xae, 0x6b],
  trackType: [0x83],
} as const;

export interface Fixture {
  bytes: Uint8Array;
  codecPrivate: Uint8Array;
  expectedDuration: number;
  payloads: Uint8Array[];
}

interface ClusterFixture {
  payloads: Uint8Array[];
  timecode: number;
  blockTimecodes: number[];
}

function concat(...parts: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(
    parts.reduce((length, part) => length + part.length, 0),
  );
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function id(bytes: readonly number[]): Uint8Array {
  return Uint8Array.from(bytes);
}

function vint(value: number): Uint8Array {
  for (let length = 1; length <= 8; length += 1) {
    if (value < 2 ** (7 * length) - 1) {
      const output = new Uint8Array(length);
      let remaining = value;
      for (let index = length - 1; index >= 0; index -= 1) {
        output[index] = remaining & 0xff;
        remaining = Math.floor(remaining / 256);
      }
      output[0] = (output[0] ?? 0) | (1 << (8 - length));
      return output;
    }
  }
  throw new Error('Fixture value is too large for an EBML variable integer.');
}

function element(elementId: readonly number[], data: Uint8Array): Uint8Array {
  return concat(id(elementId), vint(data.length), data);
}

function master(
  elementId: readonly number[],
  ...children: readonly Uint8Array[]
): Uint8Array {
  return element(elementId, concat(...children));
}

function unsigned(value: number, minimumBytes = 1): Uint8Array {
  let width = minimumBytes;
  while (value >= 2 ** (width * 8)) {
    width += 1;
  }
  const output = new Uint8Array(width);
  let remaining = value;
  for (let index = width - 1; index >= 0; index -= 1) {
    output[index] = remaining & 0xff;
    remaining = Math.floor(remaining / 256);
  }
  return output;
}

function float64(value: number): Uint8Array {
  const data = new Uint8Array(8);
  new DataView(data.buffer).setFloat64(0, value);
  return data;
}

function ascii(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function simpleBlock(timecode: number, payload: Uint8Array): Uint8Array {
  const header = new Uint8Array(4);
  header[0] = 0x81;
  new DataView(header.buffer).setInt16(1, timecode);
  header[3] = 0x80;
  return element(IDS.simpleBlock, concat(header, payload));
}

function cluster(fixture: ClusterFixture): Uint8Array {
  return master(
    IDS.cluster,
    element(IDS.timecode, unsigned(fixture.timecode)),
    ...fixture.payloads.map((payload, index) =>
      simpleBlock(fixture.blockTimecodes[index] ?? 0, payload),
    ),
  );
}

function generatedPayload(seed: number, length: number): Uint8Array {
  return Uint8Array.from(
    { length },
    (_, index) => (seed * 31 + index * 17) & 0xff,
  );
}

function makeStreamingFixture(options: {
  clusters: ClusterFixture[];
  codecPrivateLength?: number;
  duration?: number;
}): Fixture {
  const codecPrivate = generatedPayload(7, options.codecPrivateLength ?? 19);
  const header = master(IDS.ebml, element(IDS.docType, ascii('webm')));
  const infoChildren = [element(IDS.timecodeScale, unsigned(1_000_000, 3))];
  if (options.duration !== undefined) {
    infoChildren.push(element(IDS.duration, float64(options.duration)));
  }
  const info = master(IDS.info, ...infoChildren);
  const tracks = master(
    IDS.tracks,
    master(
      IDS.trackEntry,
      element(IDS.trackNumber, unsigned(1)),
      element(IDS.trackType, unsigned(2)),
      element(IDS.codecId, ascii('A_OPUS')),
      element(IDS.codecPrivate, codecPrivate),
      master(
        IDS.audio,
        element(IDS.samplingFrequency, float64(48_000)),
        element(IDS.channels, unsigned(1)),
      ),
    ),
  );
  const clusters = options.clusters.map(cluster);
  const segment = concat(
    id(IDS.segment),
    Uint8Array.from([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]),
    info,
    tracks,
    ...clusters,
  );
  const lastCluster = options.clusters.at(-1);
  const lastTimecodes = lastCluster?.blockTimecodes ?? [];
  const finalTimecode = lastTimecodes.at(-1) ?? 0;
  const previousTimecode = lastTimecodes.at(-2) ?? 0;

  return {
    bytes: concat(header, segment),
    codecPrivate,
    expectedDuration:
      (lastCluster?.timecode ?? 0) +
      finalTimecode +
      (finalTimecode - previousTimecode),
    payloads: options.clusters.flatMap(({ payloads }) => payloads),
  };
}

export function missingDurationFixture(): Fixture {
  return makeStreamingFixture({
    clusters: [
      {
        blockTimecodes: [0, 20],
        payloads: [generatedPayload(1, 12), generatedPayload(2, 13)],
        timecode: 0,
      },
    ],
  });
}

export function multipleClustersFixture(): Fixture {
  return makeStreamingFixture({
    clusters: [
      {
        blockTimecodes: [0, 20],
        payloads: [generatedPayload(3, 11), generatedPayload(4, 12)],
        timecode: 0,
      },
      {
        blockTimecodes: [0, 20],
        payloads: [generatedPayload(5, 13), generatedPayload(6, 14)],
        timecode: 100,
      },
    ],
  });
}

export function multiByteSizesFixture(): Fixture {
  return makeStreamingFixture({
    clusters: [
      {
        blockTimecodes: [0, 20],
        payloads: [generatedPayload(8, 140), generatedPayload(9, 141)],
        timecode: 0,
      },
    ],
    codecPrivateLength: 140,
  });
}

/**
 * Content-free analogue of the affected recording: zero Duration, unknown-size
 * Segment, no SeekHead/Cues, multiple clusters, Opus metadata, and a final
 * encoded timeline of 20,818 timecode units. Payload bytes are deterministic
 * generated test data and never came from a user recording.
 */
export function sanitizedRegressionFixture(): Fixture {
  return makeStreamingFixture({
    clusters: [
      {
        blockTimecodes: [0, 19],
        payloads: [generatedPayload(10, 24), generatedPayload(11, 25)],
        timecode: 0,
      },
      {
        blockTimecodes: [0, 19],
        payloads: [generatedPayload(12, 26), generatedPayload(13, 27)],
        timecode: 10_000,
      },
      {
        blockTimecodes: [0, 19],
        payloads: [generatedPayload(14, 28), generatedPayload(15, 29)],
        timecode: 20_780,
      },
    ],
    duration: 0,
  });
}
