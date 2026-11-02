import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { cleanOriginalName } from './attachment-utils.js';

interface StorageSettings {
  endpoint: string;
  origin: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}

let settingsCache: StorageSettings | null | undefined;
let clientCache: S3Client | null = null;

function readStorageSettings(): StorageSettings | null {
  if (settingsCache !== undefined) return settingsCache;
  const endpoint = process.env.STORAGE_ENDPOINT?.trim();
  const bucket = process.env.STORAGE_BUCKET?.trim();
  const region = process.env.STORAGE_REGION?.trim();
  const accessKeyId = process.env.STORAGE_ACCESS_KEY_ID?.trim();
  const secretAccessKey = process.env.STORAGE_SECRET_ACCESS_KEY?.trim();
  if (!endpoint || !bucket || !region || !accessKeyId || !secretAccessKey) return settingsCache = null;
  try {
    const parsed = new URL(endpoint);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) return settingsCache = null;
    return settingsCache = { endpoint: parsed.toString().replace(/\/$/, ''), origin: parsed.origin, bucket, region, accessKeyId, secretAccessKey };
  } catch { return settingsCache = null; }
}

function s3(): { client: S3Client; settings: StorageSettings } | null {
  const settings = readStorageSettings();
  if (!settings) return null;
  if (!clientCache) clientCache = new S3Client({
    endpoint: settings.endpoint,
    region: settings.region,
    forcePathStyle: true,
    credentials: { accessKeyId: settings.accessKeyId, secretAccessKey: settings.secretAccessKey },
  });
  return { client: clientCache, settings };
}

export function storageIsConfigured(): boolean { return s3() !== null; }

export function storageCspOrigin(): string | null {
  const value = process.env.STORAGE_ENDPOINT?.trim();
  if (!value) return null;
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) return null;
    return parsed.origin;
  } catch { return null; }
}

export async function signUploadUrl(storageKey: string, mimeType: string): Promise<string> {
  const current = s3();
  if (!current) throw new Error('storage unavailable');
  const command = new PutObjectCommand({ Bucket: current.settings.bucket, Key: storageKey, ContentType: mimeType });
  return getSignedUrl(current.client, command, { expiresIn: 300, signableHeaders: new Set(['content-type']) });
}

function safeContentDisposition(name: string, mode: 'inline' | 'attachment'): string {
  const safeName = cleanOriginalName(name);
  const fallback = safeName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\;]/g, '_');
  return `${mode}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(safeName)}`;
}

export async function signReadUrl(storageKey: string, mimeType: string, originalName: string, download: boolean, expiresIn = 3600): Promise<string> {
  const current = s3();
  if (!current) throw new Error('storage unavailable');
  const command = new GetObjectCommand({
    Bucket: current.settings.bucket,
    Key: storageKey,
    ResponseContentType: mimeType,
    ResponseContentDisposition: safeContentDisposition(originalName, download ? 'attachment' : 'inline'),
    ResponseCacheControl: 'private, no-store',
  });
  return getSignedUrl(current.client, command, { expiresIn });
}

export async function copyStoredObject(sourceKey: string, destinationKey: string, mimeType: string): Promise<void> {
  const current = s3();
  if (!current) throw new Error('storage unavailable');
  const copySource = `/${current.settings.bucket}/${sourceKey.split('/').map(encodeURIComponent).join('/')}`;
  await current.client.send(new CopyObjectCommand({
    Bucket: current.settings.bucket,
    Key: destinationKey,
    CopySource: copySource,
    ContentType: mimeType,
    MetadataDirective: 'REPLACE',
  }));
}

export async function inspectStoredObject(storageKey: string): Promise<{ sizeBytes: number | null; firstBytes: Uint8Array }> {
  const current = s3();
  if (!current) throw new Error('storage unavailable');
  const head = await current.client.send(new HeadObjectCommand({ Bucket: current.settings.bucket, Key: storageKey }));
  const sizeBytes = typeof head.ContentLength === 'number' && Number.isSafeInteger(head.ContentLength) ? head.ContentLength : null;
  const ranged = await current.client.send(new GetObjectCommand({ Bucket: current.settings.bucket, Key: storageKey, Range: 'bytes=0-1023' }));
  if (!ranged.Body) throw new Error('object body unavailable');
  return { sizeBytes, firstBytes: await ranged.Body.transformToByteArray() };
}

export async function deleteStoredObject(storageKey: string): Promise<void> {
  const current = s3();
  if (!current) throw new Error('storage unavailable');
  await current.client.send(new DeleteObjectCommand({ Bucket: current.settings.bucket, Key: storageKey }));
}
