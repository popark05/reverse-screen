import {
  HeadObjectCommand, PutObjectCommand, GetObjectCommand, S3Client
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { ObjectStorage, CreateUploadUrlInput, PutObjectInput, ObjectHead } from "./object-storage.js";

export interface S3ObjectStorageOptions {
  bucket: string;
  region: string;
  endpoint?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  forcePathStyle?: boolean;
}

export class S3ObjectStorage implements ObjectStorage {
  private readonly client: S3Client;
  constructor(private readonly options: S3ObjectStorageOptions) {
    this.client = new S3Client({
      region: options.region,
      ...(options.endpoint ? { endpoint: options.endpoint } : {}),
      ...(options.accessKeyId && options.secretAccessKey
        ? { credentials: { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey } }
        : {}),
      forcePathStyle: options.forcePathStyle ?? false
    });
  }

  async createUploadUrl(input: CreateUploadUrlInput): Promise<{ url: string; headers: Record<string, string> }> {
    const checksum = Buffer.from(input.sha256, "hex").toString("base64");
    const command = new PutObjectCommand({
      Bucket: this.options.bucket, Key: input.key, ContentType: input.contentType, ChecksumSHA256: checksum
    });
    const url = await getSignedUrl(this.client, command, {
      expiresIn: input.expiresInSeconds,
      signableHeaders: new Set(["content-type"]),
      unhoistableHeaders: new Set(["x-amz-checksum-sha256"])
    });
    return {
      url,
      headers: { "content-type": input.contentType, "x-amz-checksum-sha256": checksum }
    };
  }

  async putObject(input: PutObjectInput): Promise<void> {
    const checksum = Buffer.from(input.sha256, "hex").toString("base64");
    await this.client.send(new PutObjectCommand({
      Bucket: this.options.bucket, Key: input.key, Body: input.body,
      ContentType: input.contentType, ChecksumSHA256: checksum
    }));
  }

  async headObject(key: string): Promise<ObjectHead | undefined> {
    try {
      const result = await this.client.send(new HeadObjectCommand({
        Bucket: this.options.bucket, Key: key, ChecksumMode: "ENABLED"
      }));
      if (typeof result.ContentLength !== "number") return undefined;
      return {
        byteSize: result.ContentLength,
        ...(result.ContentType ? { contentType: result.ContentType } : {}),
        ...(result.ChecksumSHA256 ? { sha256: result.ChecksumSHA256 } : {})
      };
    } catch (error) {
      const name = error instanceof Error ? error.name : "";
      const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (name === "NotFound" || name === "NoSuchKey" || status === 404) return undefined;
      throw error;
    }
  }

  async createDownloadUrl(key: string, expiresInSeconds: number): Promise<string> {
    return getSignedUrl(this.client, new GetObjectCommand({
      Bucket: this.options.bucket, Key: key
    }), { expiresIn: expiresInSeconds });
  }

  async close(): Promise<void> { this.client.destroy(); }
}
