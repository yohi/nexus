import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';

import xxhash, { type XXHashAPI } from 'xxhash-wasm';

let hasherPromise: Promise<XXHashAPI> | undefined;

const getHasher = async (): Promise<XXHashAPI> => {
  if (hasherPromise === undefined) {
    hasherPromise = xxhash();
  }

  return hasherPromise;
};

const toHex = (value: bigint): string => value.toString(16).padStart(16, '0');

export const computeFileHash = async (filePath: string): Promise<string> => {
  const hasher = await getHasher();
  const buffer = await readFile(filePath);
  return toHex(hasher.h64Raw(buffer));
};

export const computeFileHashStreaming = async (filePath: string): Promise<string> => {
  const hasher = await getHasher();
  const stream = createReadStream(filePath);
  const chunks: Uint8Array[] = [];

  for await (const chunk of stream) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : new Uint8Array(chunk));
  }

  return toHex(hasher.h64Raw(Buffer.concat(chunks)));
};

export const computePartialHash = async (filePath: string, fileSize?: number): Promise<string> => {
  const size = fileSize ?? (await stat(filePath)).size;

  if (size <= 10 * 1024 * 1024) {
    return computeFileHash(filePath);
  }

  const hasher = await getHasher();
  const buffer = await readFile(filePath);
  const head = buffer.subarray(0, 1024 * 1024);
  const tail = buffer.subarray(-1024 * 1024);

  return toHex(hasher.h64Raw(Buffer.concat([head, tail, Buffer.from(String(size))])));
};
