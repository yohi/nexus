import { createReadStream } from 'node:fs';
import { open, readFile, stat } from 'node:fs/promises';

import xxhash, { type XXHashAPI } from 'xxhash-wasm';

let hasherPromise: Promise<XXHashAPI> | undefined;

const getHasher = async (): Promise<XXHashAPI> => {
  if (hasherPromise === undefined) {
    hasherPromise = xxhash().catch((err) => {
      hasherPromise = undefined;
      throw err;
    });
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
  const context = hasher.create64();

  for await (const chunk of stream) {
    context.update(typeof chunk === 'string' ? Buffer.from(chunk) : new Uint8Array(chunk));
  }

  return toHex(context.digest());
};

export const computeStringHash = async (content: string): Promise<string> => {
  const hasher = await getHasher();
  return toHex(hasher.h64Raw(Buffer.from(content)));
};

export const computePartialHash = async (filePath: string, fileSize?: number): Promise<string> => {
  const size = fileSize ?? (await stat(filePath)).size;

  if (size <= 2 * 1024 * 1024) {
    return computeFileHash(filePath);
  }

  const hasher = await getHasher();
  const fd = await open(filePath, 'r');
  try {
    const head = Buffer.alloc(1024 * 1024);
    const tail = Buffer.alloc(1024 * 1024);
    const { bytesRead: headBytes } = await fd.read(head, 0, head.length, 0);
    const { bytesRead: tailBytes } = await fd.read(tail, 0, tail.length, size - tail.length);
    return toHex(
      hasher.h64Raw(
        Buffer.concat([
          head.subarray(0, headBytes),
          tail.subarray(0, tailBytes),
          Buffer.from(String(size)),
        ]),
      ),
    );
  } finally {
    await fd.close();
  }
};
