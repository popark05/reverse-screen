import { Pool } from "pg";
import { MobilewrightDiscoveryAdapter } from "../adapters/mobilewright-discovery-adapter.js";
import { InMemoryDiscoveryEventStore } from "../domain/discovery-event.js";
import { InMemoryDiscoverySessionStore } from "../domain/discovery-session.js";
import { InMemoryEvidenceArtifactStore } from "../domain/evidence-artifact.js";
import { PostgresDiscoveryRepository, PostgresEvidenceArtifactRepository } from "../infrastructure/postgres-discovery-repository.js";
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

const app = databaseUrl
  ? (() => {
      const pool = new Pool({ connectionString: databaseUrl, max: Number(process.env.DB_POOL_MAX ?? 10) });
      const repository = new PostgresDiscoveryRepository(pool);
      const evidence = new PostgresEvidenceArtifactRepository(pool);
      return buildApp({
        store: repository, sessions: repository, evidence,
        ...(observer ? { observer } : {}), onClose: () => pool.end()
      });
    })()
  : buildApp({
      store: new InMemoryDiscoveryEventStore(),
      sessions: new InMemoryDiscoverySessionStore(),
      evidence: new InMemoryEvidenceArtifactStore(),
      ...(observer ? { observer } : {})
    });

try {
  await app.listen({ port, host });
} catch (error) {
  app.log.error(error);
  process.exitCode = 1;
  await app.close();
}
