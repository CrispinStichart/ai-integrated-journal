export const WEBM_IDS = {
  audio: 0xe1,
  block: 0xa1,
  blockGroup: 0xa0,
  cluster: 0x1f43b675,
  codecDelay: 0x56aa,
  cues: 0x1c53bb6b,
  cueClusterPosition: 0xf1,
  cuePoint: 0xbb,
  cueTime: 0xb3,
  cueTrack: 0xf7,
  cueTrackPositions: 0xb7,
  defaultDuration: 0x23e383,
  docType: 0x4282,
  duration: 0x4489,
  ebml: 0x1a45dfa3,
  info: 0x1549a966,
  seek: 0x4dbb,
  seekHead: 0x114d9b74,
  seekId: 0x53ab,
  seekPosition: 0x53ac,
  segment: 0x18538067,
  simpleBlock: 0xa3,
  timecode: 0xe7,
  timecodeScale: 0x2ad7b1,
  trackEntry: 0xae,
  trackNumber: 0xd7,
  tracks: 0x1654ae6b,
  trackType: 0x83,
} as const;

// Matroska/WebM master element IDs. Unknown IDs remain opaque leaf data, which
// allows them to round-trip without guessing at an unrecognized structure.
export const MASTER_ELEMENT_IDS: ReadonlySet<number> = new Set([
  0x80, 0x8e, 0x8f, 0xa0, 0xa6, 0xae, 0xb6, 0xb7, 0xbb, 0xc8, 0xdb, 0xe0, 0xe1,
  0xe2, 0xe3, 0xe4, 0xe8, 0xe9, 0x45b9, 0x4dbb, 0x5034, 0x5035, 0x55b0, 0x5854,
  0x61a7, 0x6240, 0x63c0, 0x6624, 0x67c8, 0x6911, 0x6924, 0x6944, 0x6d80,
  0x7373, 0x75a1, 0x7e5b, 0x7e7b, 0x1043a770, 0x114d9b74, 0x1254c367,
  0x1549a966, 0x1654ae6b, 0x18538067, 0x1941a469, 0x1a45dfa3, 0x1b538667,
  0x1c53bb6b, 0x1f43b675,
]);

export interface EbmlElement {
  readonly children?: readonly EbmlElement[];
  readonly data: Uint8Array;
  readonly dataEnd: number;
  readonly dataStart: number;
  readonly id: number;
  readonly idBytes: Uint8Array;
  readonly sizeBytes: Uint8Array;
  readonly tagStart: number;
  readonly unknownSize: boolean;
}

export interface ParsedWebm {
  readonly bytes: Uint8Array;
  readonly header: EbmlElement;
  readonly segment: EbmlElement;
}
