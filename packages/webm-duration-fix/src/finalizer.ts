import { concatBytes } from './bytes.js';
import {
  copyElement,
  encodeDuration,
  encodeElement,
  encodeMaster,
  encodeUnknownSizeMaster,
  encodeUnsignedElement,
  idBytes,
} from './encoder.js';
import { InvalidEbmlError, NumericOverflowError } from './errors.js';
import { assertBoundedSize, type ResourceLimits } from './limits.js';
import { WEBM_IDS, type EbmlElement, type ParsedWebm } from './ebml.js';
import {
  calculateWebmMetadata,
  type CuePoint,
  type WebmMetadataPlan,
} from './metadata.js';
import { parseWebm } from './parser.js';

function encodeInfo(info: EbmlElement, duration: number): Uint8Array {
  const children = info.children;
  if (children === undefined)
    throw new InvalidEbmlError('Info is not a master element.');
  const retained = children
    .filter((element) => element.id !== WEBM_IDS.duration)
    .map(copyElement);
  retained.splice(0, 0, encodeDuration(duration));
  return encodeMaster(WEBM_IDS.info, retained);
}

function encodeSeekHead(
  infoStart: number,
  tracksStart: number,
  cuesStart: number,
): Uint8Array {
  const seek = (targetId: number, position: number): Uint8Array =>
    encodeMaster(WEBM_IDS.seek, [
      encodeElement(WEBM_IDS.seekId, idBytes(targetId)),
      encodeUnsignedElement(WEBM_IDS.seekPosition, position),
    ]);
  return encodeMaster(WEBM_IDS.seekHead, [
    seek(WEBM_IDS.info, infoStart),
    seek(WEBM_IDS.tracks, tracksStart),
    seek(WEBM_IDS.cues, cuesStart),
  ]);
}

function encodeCues(cues: readonly CuePoint[], offset: number): Uint8Array {
  return encodeMaster(
    WEBM_IDS.cues,
    cues.map((cue) =>
      encodeMaster(WEBM_IDS.cuePoint, [
        encodeUnsignedElement(WEBM_IDS.cueTime, cue.time),
        encodeMaster(WEBM_IDS.cueTrackPositions, [
          encodeUnsignedElement(WEBM_IDS.cueTrack, cue.track),
          encodeUnsignedElement(
            WEBM_IDS.cueClusterPosition,
            cue.clusterPosition + offset,
          ),
        ]),
      ]),
    ),
  );
}

function encodeMetadata(
  parsed: ParsedWebm,
  plan: WebmMetadataPlan,
  maximumMetadataBytes: number,
): Uint8Array {
  const retainedSourceBytes = plan.retainedLevelOneElements.reduce(
    (total, element) => total + element.dataEnd - element.tagStart,
    parsed.header.dataEnd -
      parsed.header.tagStart +
      (plan.info.dataEnd - plan.info.tagStart) +
      (plan.tracks.dataEnd - plan.tracks.tagStart),
  );
  assertBoundedSize(
    retainedSourceBytes,
    maximumMetadataBytes,
    'WebM retained metadata',
  );
  const header = copyElement(parsed.header);
  const segmentPrefix = encodeUnknownSizeMaster(WEBM_IDS.segment);
  const info = encodeInfo(plan.info, plan.duration);
  const tracks = copyElement(plan.tracks);
  const retained = plan.retainedLevelOneElements.map(copyElement);
  const originalMetadataSize =
    plan.firstClusterOffset - parsed.segment.dataStart;
  let seekHeadSize = 47;
  let cuesSize = 5 + plan.cues.length * 15;
  let seekHead: Uint8Array = new Uint8Array();
  let cues: Uint8Array = new Uint8Array();
  let previousDifference: number | undefined;
  for (let iteration = 0; iteration < 10; iteration += 1) {
    const infoStart = seekHeadSize;
    const tracksStart = infoStart + info.byteLength;
    const cuesStart =
      tracksStart +
      tracks.byteLength +
      retained.reduce((sum, item) => sum + item.byteLength, 0);
    const metadataSize = cuesStart + cuesSize;
    const difference = metadataSize - originalMetadataSize;
    if (
      !Number.isSafeInteger(infoStart) ||
      !Number.isSafeInteger(tracksStart) ||
      !Number.isSafeInteger(cuesStart) ||
      !Number.isSafeInteger(difference)
    ) {
      throw new InvalidEbmlError('WebM metadata has impossible offsets.');
    }
    seekHead = encodeSeekHead(infoStart, tracksStart, cuesStart);
    cues = encodeCues(plan.cues, difference - parsed.segment.dataStart);
    seekHeadSize = seekHead.byteLength;
    cuesSize = cues.byteLength;
    if (previousDifference === difference) break;
    previousDifference = difference;
    if (iteration === 9)
      throw new InvalidEbmlError('WebM metadata offsets did not converge.');
  }
  return concatBytes(
    [header, segmentPrefix, seekHead, info, tracks, ...retained, cues],
    maximumMetadataBytes,
  );
}

export function finalizeContainer(
  input: Uint8Array,
  limits: ResourceLimits,
): {
  readonly bytes: Uint8Array;
  readonly changed: boolean;
} {
  const parsed = parseWebm(input, {
    maximumMetadataBytes: limits.maximumMetadataBytes,
  });
  const plan = calculateWebmMetadata(parsed);
  const metadata = encodeMetadata(parsed, plan, limits.maximumMetadataBytes);
  const maximumOutputBytes = input.byteLength + limits.maximumMetadataBytes;
  if (!Number.isSafeInteger(maximumOutputBytes)) {
    throw new NumericOverflowError(
      'WebM output size exceeds the safe integer range.',
    );
  }
  const bytes = concatBytes(
    [metadata, input.subarray(plan.firstClusterOffset)],
    maximumOutputBytes,
  );
  const changed =
    bytes.byteLength !== input.byteLength ||
    bytes.some((byte, index) => byte !== input[index]);
  return { bytes: changed ? bytes : input, changed };
}
