import { decodeUnsigned } from './bytes.js';
import { InvalidEbmlError } from './errors.js';
import { WEBM_IDS, type EbmlElement, type ParsedWebm } from './ebml.js';

export interface CuePoint {
  readonly clusterPosition: number;
  readonly time: number;
  readonly track: number;
}

export interface WebmMetadataPlan {
  readonly cues: readonly CuePoint[];
  readonly duration: number;
  readonly firstClusterOffset: number;
  readonly info: EbmlElement;
  readonly retainedLevelOneElements: readonly EbmlElement[];
  readonly tracks: EbmlElement;
}

function child(element: EbmlElement, id: number): EbmlElement | undefined {
  return element.children?.find((candidate) => candidate.id === id);
}

function parseBlockHeader(data: Uint8Array): {
  readonly timecode: number;
  readonly track: number;
} {
  const first = data[0];
  if (first === undefined || first === 0)
    throw new InvalidEbmlError('Block has an invalid track number.');
  const trackLength = Math.clz32(first) - 24 + 1;
  if (trackLength > 8 || data.byteLength < trackLength + 3) {
    throw new InvalidEbmlError('Block header is truncated.');
  }
  let track = first & (0xff >> trackLength);
  for (let index = 1; index < trackLength; index += 1)
    track = track * 256 + (data[index] ?? 0);
  const view = new DataView(data.buffer, data.byteOffset + trackLength, 2);
  return { timecode: view.getInt16(0), track };
}

export function calculateWebmMetadata(parsed: ParsedWebm): WebmMetadataPlan {
  const levelOne = parsed.segment.children ?? [];
  const info = levelOne.find((element) => element.id === WEBM_IDS.info);
  const tracks = levelOne.find((element) => element.id === WEBM_IDS.tracks);
  const clusters = levelOne.filter(
    (element) => element.id === WEBM_IDS.cluster,
  );
  if (info === undefined || tracks === undefined || clusters.length === 0) {
    throw new InvalidEbmlError(
      'WebM requires Info, Tracks, and at least one Cluster.',
    );
  }

  const trackTypes = new Map<number, number>();
  const codecDelays = new Map<number, number>();
  for (const entry of tracks.children?.filter(
    (element) => element.id === WEBM_IDS.trackEntry,
  ) ?? []) {
    const number = child(entry, WEBM_IDS.trackNumber);
    const type = child(entry, WEBM_IDS.trackType);
    if (number === undefined || type === undefined) continue;
    const track = decodeUnsigned(number.data);
    trackTypes.set(track, decodeUnsigned(type.data));
    const codecDelay = child(entry, WEBM_IDS.codecDelay);
    if (codecDelay !== undefined)
      codecDelays.set(track, decodeUnsigned(codecDelay.data));
  }
  const videoTrack = [...trackTypes].find(([, type]) => type === 1)?.[0];
  const audioTrack = [...trackTypes].find(([, type]) => type === 2)?.[0];
  const cueTrack = videoTrack ?? audioTrack;
  if (cueTrack === undefined)
    throw new InvalidEbmlError('WebM contains no audio or video track.');

  const timecodeScaleElement = child(info, WEBM_IDS.timecodeScale);
  const timecodeScale =
    timecodeScaleElement === undefined
      ? 1_000_000
      : decodeUnsigned(timecodeScaleElement.data);
  const lastTwo = new Map<number, [number, number]>();
  const cues: CuePoint[] = [];
  let lastClusterTime = 0;
  for (const cluster of clusters) {
    const clusterTimeElement = child(cluster, WEBM_IDS.timecode);
    const clusterTime =
      clusterTimeElement === undefined
        ? 0
        : decodeUnsigned(clusterTimeElement.data);
    lastClusterTime = clusterTime;
    let firstRelevantBlock:
      { readonly timecode: number; readonly track: number } | undefined;
    for (const element of cluster.children ?? []) {
      if (element.id !== WEBM_IDS.simpleBlock && element.id !== WEBM_IDS.block)
        continue;
      const block = parseBlockHeader(element.data);
      if (trackTypes.has(block.track)) {
        const previous = lastTwo.get(block.track) ?? [0, 0];
        lastTwo.set(block.track, [previous[1], block.timecode]);
      }
      if (firstRelevantBlock === undefined && block.track === cueTrack)
        firstRelevantBlock = block;
    }
    if (firstRelevantBlock !== undefined) {
      cues.push({
        clusterPosition: cluster.tagStart,
        time: clusterTime + firstRelevantBlock.timecode,
        track: cueTrack,
      });
    }
  }
  const durationTrack =
    videoTrack !== undefined &&
    audioTrack !== undefined &&
    (lastTwo.get(audioTrack)?.[1] ?? 0) > (lastTwo.get(videoTrack)?.[1] ?? 0)
      ? audioTrack
      : cueTrack;
  const selected = lastTwo.get(durationTrack) ?? [0, 0];
  const frameDurationNanoseconds = (selected[1] - selected[0]) * timecodeScale;
  const duration = Math.floor(
    ((lastClusterTime + selected[1]) * timecodeScale +
      frameDurationNanoseconds -
      (codecDelays.get(durationTrack) ?? 0)) /
      timecodeScale,
  );
  if (!Number.isSafeInteger(duration) || duration < 0)
    throw new InvalidEbmlError('Calculated WebM duration is invalid.');
  return {
    cues,
    duration,
    firstClusterOffset: clusters[0]?.tagStart ?? parsed.bytes.byteLength,
    info,
    retainedLevelOneElements: levelOne.filter(
      (element) =>
        !new Set<number>([
          WEBM_IDS.info,
          WEBM_IDS.tracks,
          WEBM_IDS.cluster,
          WEBM_IDS.seekHead,
          WEBM_IDS.cues,
        ]).has(element.id),
    ),
    tracks,
  };
}
