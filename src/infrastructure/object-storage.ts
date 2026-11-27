export interface CreateUploadUrlInput {
  key: string;
  contentType: string;
  sha256: string;
  expiresInSeconds: number;
}
export interface ObjectHead {
  byteSize: number;
  contentType?: string;
  sha256?: string;
}
export interface ObjectStorage {
  createUploadUrl(input: CreateUploadUrlInput): Promise<{ url: string; headers: Record<string, string> }>;
  headObject(key: string): Promise<ObjectHead | undefined>;
  createDownloadUrl(key: string, expiresInSeconds: number): Promise<string>;
}
