// @ts-nocheck -- Exact upstream behavior baseline; Task 4 modernizes its types.
import { tools, Decoder, Reader } from './ebml/index.js';

/**
 * based on ts-ebml and support large file，optimize memory usage during repair
 *
 * @param blob the blob you need to fix
 * @returns the blob that has been fixed
 *
 */
export default async function fixWebmDuration(blob: Blob): Promise<Blob> {
  if (!blob) {
    throw Error('call to fixWebmDuration requires a blob');
  }
  const decoder = new Decoder();
  const reader = new Reader();
  const readstream = blob.stream() as any;
  const readerBlob = readstream.getReader();

  while (true) {
    let { done, value } = await readerBlob.read();
    if (done) {
      reader.stop();
      break;
    }
    let elms = decoder.decode(value);
    // As browser upgrade webm meta attributes are gradually added,
    // so filter unknown type to bypass this issue.
    elms = elms?.filter(elm => elm.type !== 'unknown')
    elms.forEach(elm => {
      reader.read(elm)
    });
    value = null;
  }
  const refinedMetadataBuf = tools.makeMetadataSeekable(reader.metadatas, reader.duration, reader.cues);
  const refinedMetadataBlob = new Blob([refinedMetadataBuf], { type: blob.type });
  const firstPartBlobWithoutMetadata = blob.slice(reader.metadataSize);
  const finalBlob = new Blob([refinedMetadataBlob, firstPartBlobWithoutMetadata], { type: blob.type });

  return finalBlob;
}
