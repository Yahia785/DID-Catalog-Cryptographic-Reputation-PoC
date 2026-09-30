import crypto from 'node:crypto';
import fs from 'node:fs';

export const sha256 = (data: string | Uint8Array) => crypto.createHash('sha256').update(data).digest('hex');

/** SHA-256 of a file's exact bytes. */
export const sha256File = (path: string) => sha256(fs.readFileSync(path));
