import crypto from 'node:crypto';


export const stableHash = (value: unknown): string => {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
};
