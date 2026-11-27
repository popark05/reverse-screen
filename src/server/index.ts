import { Pool } from "pg";
import { MobilewrightDiscoveryAdapter } from "../adapters/mobilewright-discovery-adapter.js";
import { InMemoryDiscoveryEventStore } from "../domain/discovery-event.js";
import { InMemoryDiscoverySessionStore } from "../domain/discovery-session.js";
import { InMemoryEvidenceArtifactStore } from "../domain/evidence-artifact.js";
import { PostgresDiscoveryRepository, PostgresEvidenceArtifactRepository } from "../infrastructure/postgres-discovery-repository.js";
import { S3ObjectStorage } from "../infrastructure/s3-object-storage.js";
import { buildApp } from "./app.js";

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "0.0.0.0";
const databaseUrl = process.env.DATABASE_URL;
const mobileAdapter = process.env.MOBILE_DISCOVERY_ADAPTER ?? "disabled";
const observer = mobileAdapter === "mobilewright"
  ? new MobilewrightDiscoveryAdapter({
      bundleId: process.env.MOBILE_APP_BUNDLE_ID ?? "",
      ...(process.env.MOBILE_APP_PATH ? { installAppPath: process.env.MOBILE_APP_PATH } : {}),
      maxElements: Number(process.env.MOBILE_DISCOVERY_MAX_ELEMENTS ?? 300),
      maxWebViewElements: Number(process.env.MOBILE_DISCOVERY_MAX_WEBVIEW_ELEMENTS ?? 200)
    })
  : undefined;

if (mobileAdapter !== "disabled" && mobileAdapter !== "mobilewright") {
  throw new Error("MOBILE_DISCOVERY_ADAPTER must be disabled or mobilewright");
}

const s3Bucket = process.env.S3_BUCKET;
const objectStorage = s3Bucket
  ? new S3ObjectStorage({
      bucket: s3Bucket,
      region: process.env.S3_REGION ?? "us-east-1",
      ...(process.env.S3_ENDPOINT ? { endpoint: process.env.S3_ENDPOINT } : {}),
      ...(process.env.S3_ACCESS_KEY_ID ? { accessKeyId: process.env.S3_ACCESS_KEY_ID } : {}),
      ...(process.env.S3_SECRET_ACCESS_KEY ? { secretAccessKey: process.env.S3_SECRET_ACCESS_KEY } : {}),
      forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true"
    })
  : undefined;

const pool = databaseUrl
  ? new Pool({ connectionString: databaseUrl, max: Number(process.env.DB_POOL_MAX ?? 10) })
  : undefined;
const repository = pool ? new PostgresDiscoveryRepository(pool) : undefined;
const evidenceRepository = pool ? new PostgresEvidenceArtifactRepository(pool) : undefined;

const app = buildApp({
  store: repository ?? new InMemoryDiscoveryEventStore(),
  sessions: repository ?? new InMemoryDiscoverySessionStore(),
  evidence: evidenceRepository ?? new InMemoryEvidenceArtifactStore(),
  ...(observer ? { observer } : {}),
  ...(objectStorage ? {
    objectStorage,
    objectStorageBucket: s3Bucket!,
    uploadUrlTtlSeconds: Number(process.env.S3_PRESIGN_TTL_SECONDS ?? 300),
    downloadUrlTtlSeconds: Number(process.env.S3_DOWNLOAD_TTL_SECONDS ?? 300)
  } : {}),
  ...(pool || objectStorage ? {
    onClose: async () => {
      await objectStorage?.close();
      await pool?.end();
    }
  } : {})
});

try {
  await app.listen({ port, host });
} catch (error) {
  app.log.error(error);
  process.exitCode = 1;
  await app.close();
}
