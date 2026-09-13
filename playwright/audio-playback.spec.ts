import {
  chromium,
  expect,
  test,
  type Page,
  type TestInfo,
} from '@playwright/test';

import { finalizeWebmBytes } from '../packages/webm-duration-fix/dist/index.js';

const WEBM_MIME_TYPE = 'audio/webm;codecs=opus';
const CAPTURE_MILLISECONDS = 750;

interface MediaCapabilities {
  readonly wavPlayback: string;
  readonly webmCapture: boolean;
  readonly webmPlayback: string;
}

interface PlaybackObservation {
  readonly advancedTime: number;
  readonly completedTime: number;
  readonly duration: number;
  readonly initialTime: number;
  readonly seekableEnd: number;
  readonly soughtTime: number;
  readonly totalLength: string;
}

async function mediaCapabilities(page: Page): Promise<MediaCapabilities> {
  return page.evaluate((mimeType) => {
    const audio = document.createElement('audio');
    return {
      wavPlayback: audio.canPlayType('audio/wav'),
      webmCapture:
        typeof MediaRecorder !== 'undefined' &&
        MediaRecorder.isTypeSupported(mimeType),
      webmPlayback: audio.canPlayType(mimeType),
    };
  }, WEBM_MIME_TYPE);
}

async function captureSyntheticWebm(page: Page): Promise<Uint8Array> {
  const bytes = await page.evaluate(
    async ({ captureMilliseconds, mimeType }) => {
      const context = new AudioContext();
      const oscillator = context.createOscillator();
      const destination = context.createMediaStreamDestination();
      oscillator.frequency.value = 440;
      oscillator.connect(destination);
      const recorder = new MediaRecorder(destination.stream, { mimeType });
      const chunks: Blob[] = [];
      recorder.addEventListener('dataavailable', (event) => {
        if (event.data.size > 0) chunks.push(event.data);
      });
      const stopped = new Promise<void>((resolve) => {
        recorder.addEventListener('stop', () => resolve(), { once: true });
      });

      recorder.start(50);
      oscillator.start();
      await new Promise((resolve) => setTimeout(resolve, captureMilliseconds));
      recorder.stop();
      oscillator.stop();
      await stopped;
      await context.close();
      return Array.from(
        new Uint8Array(
          await new Blob(chunks, { type: mimeType }).arrayBuffer(),
        ),
      );
    },
    { captureMilliseconds: CAPTURE_MILLISECONDS, mimeType: WEBM_MIME_TYPE },
  );
  return Uint8Array.from(bytes);
}

async function syntheticWebmFor(
  page: Page,
  capabilities: MediaCapabilities,
  testInfo: TestInfo,
): Promise<Uint8Array> {
  if (capabilities.webmCapture) {
    testInfo.annotations.push({
      type: 'media-path',
      description: `${testInfo.project.name} generated its own synthetic Opus/WebM fixture`,
    });
    return captureSyntheticWebm(page);
  }

  testInfo.annotations.push({
    type: 'media-path',
    description: `${testInfo.project.name} cannot capture Opus/WebM; Chromium generated the synthetic playback fixture`,
  });
  const generator = await chromium.launch();
  try {
    const generatorPage = await generator.newPage();
    expect(
      (await mediaCapabilities(generatorPage)).webmCapture,
      'the explicit WebM fixture generator must support MediaRecorder',
    ).toBe(true);
    return await captureSyntheticWebm(generatorPage);
  } finally {
    await generator.close();
  }
}

function syntheticWav(durationSeconds = 0.8): Uint8Array {
  const sampleRate = 8_000;
  const sampleCount = Math.round(sampleRate * durationSeconds);
  const bytes = new Uint8Array(44 + sampleCount * 2);
  const view = new DataView(bytes.buffer);
  const writeAscii = (offset: number, value: string) => {
    for (const [index, character] of [...value].entries())
      bytes[offset + index] = character.charCodeAt(0);
  };
  writeAscii(0, 'RIFF');
  view.setUint32(4, bytes.byteLength - 8, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(36, 'data');
  view.setUint32(40, sampleCount * 2, true);
  for (let sample = 0; sample < sampleCount; sample += 1) {
    const value = Math.sin((sample / sampleRate) * 440 * Math.PI * 2);
    view.setInt16(44 + sample * 2, Math.round(value * 4_000), true);
  }
  return bytes;
}

async function exerciseNativePlayback(
  page: Page,
  bytes: Uint8Array,
  mimeType: string,
): Promise<PlaybackObservation> {
  await page.setContent(`
    <main>
      <h1>New recording playback</h1>
      <audio controls aria-label="Newly finalized recording"></audio>
      <p>Total length: <output aria-label="Total length">Loading</output></p>
    </main>
  `);
  const source = `data:${mimeType};base64,${Buffer.from(bytes).toString('base64')}`;
  return page.evaluate(async (mediaSource) => {
    const audio = document.querySelector('audio');
    const output = document.querySelector('output');
    if (
      !(audio instanceof HTMLAudioElement) ||
      !(output instanceof HTMLOutputElement)
    )
      throw new Error('The native playback harness did not render.');

    const once = (eventName: string) =>
      new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error(`Timed out waiting for ${eventName}.`)),
          10_000,
        );
        audio.addEventListener(
          eventName,
          () => {
            clearTimeout(timeout);
            resolve();
          },
          { once: true },
        );
      });
    const metadata = once('loadedmetadata');
    audio.src = mediaSource;
    await metadata;
    const duration = audio.duration;
    const roundedSeconds = Math.max(1, Math.ceil(duration));
    output.value = `${String(Math.floor(roundedSeconds / 60))}:${String(
      roundedSeconds % 60,
    ).padStart(2, '0')}`;

    const initialTime = audio.currentTime;
    const seeked = once('seeked');
    audio.currentTime = duration / 2;
    await seeked;
    const soughtTime = audio.currentTime;

    const rewound = once('seeked');
    audio.currentTime = 0;
    await rewound;
    const advanced = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('The native playhead did not advance.')),
        10_000,
      );
      const observe = () => {
        if (audio.currentTime <= Math.min(0.05, duration / 10)) return;
        clearTimeout(timeout);
        audio.removeEventListener('timeupdate', observe);
        resolve();
      };
      audio.addEventListener('timeupdate', observe);
    });
    const ended = once('ended');
    audio.playbackRate = 4;
    await audio.play();
    await advanced;
    const advancedTime = audio.currentTime;
    await ended;

    return {
      advancedTime,
      completedTime: audio.currentTime,
      duration,
      initialTime,
      seekableEnd: audio.seekable.end(audio.seekable.length - 1),
      soughtTime,
      totalLength: output.value,
    };
  }, source);
}

function assertUsablePlayback(observation: PlaybackObservation): void {
  expect(Number.isFinite(observation.duration)).toBe(true);
  expect(observation.duration).toBeGreaterThan(0);
  expect(observation.initialTime).toBe(0);
  expect(observation.totalLength).toMatch(/^\d+:[0-5]\d$/u);
  expect(observation.totalLength).not.toBe('0:00');
  expect(observation.seekableEnd).toBeCloseTo(observation.duration, 1);
  expect(observation.soughtTime).toBeCloseTo(observation.duration / 2, 1);
  expect(observation.advancedTime).toBeGreaterThan(0);
  expect(observation.completedTime).toBeCloseTo(observation.duration, 1);
}

test('[CAP-003][CAP-004] newly finalized WebM has finite native playback, seeking, total length, and a completing playhead', async ({
  page,
}, testInfo) => {
  const capabilities = await mediaCapabilities(page);
  expect(
    capabilities.webmPlayback,
    `${testInfo.project.name} must report its current WebM playback capability`,
  ).not.toBe('');
  const input = await syntheticWebmFor(page, capabilities, testInfo);
  const finalized = await finalizeWebmBytes(input);

  expect(input.slice(0, 4)).toEqual(Uint8Array.of(0x1a, 0x45, 0xdf, 0xa3));
  expect(finalized.changed).toBe(true);
  assertUsablePlayback(
    await exerciseNativePlayback(page, finalized.bytes, WEBM_MIME_TYPE),
  );
});

test('[CAP-003] non-WebM fallback has finite native playback', async ({
  page,
}, testInfo) => {
  const capabilities = await mediaCapabilities(page);
  expect(
    capabilities.wavPlayback,
    `${testInfo.project.name} must report its current WAV fallback capability`,
  ).not.toBe('');
  testInfo.annotations.push({
    type: 'media-path',
    description: `${testInfo.project.name} exercised the synthetic non-WebM pass-through fallback`,
  });
  const original = syntheticWav();

  expect(original.slice(0, 4)).toEqual(
    Uint8Array.from([...'RIFF'].map((character) => character.charCodeAt(0))),
  );
  assertUsablePlayback(
    await exerciseNativePlayback(page, original, 'audio/wav'),
  );
});
