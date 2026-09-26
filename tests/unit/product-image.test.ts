import { describe, expect, it } from 'vitest';
import { contentTypeFor, readProductImage } from '@qr/catalog/files/product-image';

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]);
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x24, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
const PDF = new TextEncoder().encode('%PDF-1.7\n1 0 obj');
const TEXT = new TextEncoder().encode('<svg xmlns="x"/>');

function streamOf(chunks: Uint8Array[]) {
  let cancelled = false;
  let index = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < chunks.length) controller.enqueue(chunks[index++]);
      else controller.close();
    },
    cancel() {
      cancelled = true;
    },
  });
  return { stream, wasCancelled: () => cancelled };
}

describe('product image inspection (D13)', () => {
  it.each([
    [JPEG, 'image/jpeg'],
    [PNG, 'image/png'],
    [WEBP, 'image/webp'],
    [PDF, null],
    [TEXT, null],
  ])('derives the MIME type from magic bytes', (bytes, expected) => {
    expect(contentTypeFor(bytes)).toBe(expected);
  });

  it('rejects a PDF whatever the client claims', async () => {
    const { stream } = streamOf([PDF]);
    expect(await readProductImage(stream, 5_000_000)).toEqual({ ok: false, code: 'product_image_type_unsupported' });
  });

  it('reads a valid image and reports its real size', async () => {
    const { stream } = streamOf([JPEG, new Uint8Array(100)]);
    const result = await readProductImage(stream, 5_000_000);
    expect(result).toMatchObject({ ok: true, contentType: 'image/jpeg', size: 112 });
  });

  it('cancels the stream as soon as the limit is exceeded', async () => {
    const chunk = new Uint8Array(1_000_000);
    chunk.set(JPEG);
    const { stream, wasCancelled } = streamOf([chunk, new Uint8Array(1_000_000), new Uint8Array(1_000_000), new Uint8Array(1_000_000), new Uint8Array(1_000_001)]);
    expect(await readProductImage(stream, 5_000_000)).toEqual({ ok: false, code: 'product_image_size_exceeded' });
    expect(wasCancelled()).toBe(true);
  });

  it('rejects an empty body', async () => {
    const { stream } = streamOf([]);
    expect(await readProductImage(stream, 5_000_000)).toEqual({ ok: false, code: 'product_image_empty' });
  });
});
