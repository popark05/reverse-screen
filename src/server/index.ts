import { Pool } from "pg";
import { InMemoryDiscoveryEventStore } from "../domain/discovery-event.js";
import { InMemoryDiscoverySessionStore } from "../domain/discovery-session.js";
import { PostgresDiscoveryRepository } from "../infrastructure/postgres-discovery-repository.js";
import { buildApp } from "./app.js";

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "0.0.0.0";
const databaseUrl = process.env.DATABASE_URL;

const app = databaseUrl
  ? (() => {
      const pool = new Pool({ connectionString: databaseUrl, max: Number(process.env.DB_POOL_MAX ?? 10) });
      const repository = new PostgresDiscoveryRepository(pool);
      return buildApp({ store: repository, sessions: repository, onClose: () => pool.end() });
    })()
  : buildApp({ store: new InMemoryDiscoveryEventStore(), sessions: new InMemoryDiscoverySessionStore() });

try {
  await app.listen({ port, host });
} catch (error) {
  app.log.error(error);
  process.exitCode = 1;
  await app.close();
}
