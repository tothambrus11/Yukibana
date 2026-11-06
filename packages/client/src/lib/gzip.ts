/** gzip in and out, on the streams both Node and the Worker provide. */

function buffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/** Returns the decompressed contents of the gzip data `bytes`, in a fresh buffer; rejects if `bytes` is not valid gzip. `bytes` is not modified. */
export async function gunzip(bytes: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new Blob([buffer(bytes)]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Returns `bytes` compressed as one gzip member (RFC 1952), in a fresh buffer. `bytes` is not modified. */
export async function gzip(bytes: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new Blob([buffer(bytes)]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
