import type { FastifyInstance, FastifyRequest } from "fastify";
import { DataSchema, SchemaField, RouteAccess, BusinessMetadata } from "./models.cjs";
import {
  getPageDir,
  readPageMeta,
  writePageMeta,
} from "./page-storage.cjs";
import {
  isValidSchemaName,
  createTable,
  alterTableAddColumn,
  dropTable,
} from "./app-db.cjs";
import { validateTransitions } from "./transitions.cjs";

const SCHEMAS_DEPRECATED_ERROR =
  "Schema management is deprecated. Write SQL migrations in migrations/ and run localapp db validate.";

export interface ApplicationSchemaHost { dataDir: string; userId(request: FastifyRequest): string }
export async function registerApplicationSchemas(app: FastifyInstance, host: ApplicationSchemaHost) {
  const dataDir = () => host.dataDir;
  // Production exposes the deprecation response; tests keep legacy setup paths for CRUD fixture coverage.
  const deprecated = (req: { headers: Record<string, unknown> }) =>
    process.env.NODE_ENV !== "test" || req.headers["x-localapp-deprecated-probe"] === "1";
  const gone = (reply: { status: (code: number) => { send: (body: unknown) => unknown } }) =>
    reply.status(410).send({ success: false, error: SCHEMAS_DEPRECATED_ERROR });

  // POST /api/schemas — create schema
  app.post("/api/schemas", async (req, reply) => {
    if (deprecated(req)) return gone(reply);
    const { pageName, name, fields, routeAccess, business } = req.body as {
      pageName: string;
      name: string;
      fields: Record<string, SchemaField>;
      routeAccess?: RouteAccess;
      business?: BusinessMetadata;
    };

    if (!pageName || !name || !fields) {
      return reply.status(400).send({ success: false, error: "pageName, name, and fields are required" });
    }

    if (!isValidSchemaName(name)) {
      return reply.status(400).send({ success: false, error: "Invalid schema name" });
    }

    const transitionError = validateTransitions(fields, business);
    if (transitionError) {
      return reply.status(400).send({ success: false, error: transitionError });
    }

    const userId = host.userId(req);
    const meta = readPageMeta(dataDir(), userId, pageName);
    if (!meta) {
      return reply.status(404).send({ success: false, error: "Page not found" });
    }

    const schemas = meta.schemas ?? [];
    if (schemas.some((s) => s.name === name)) {
      return reply.status(409).send({ success: false, error: "Schema already exists" });
    }

    const now = new Date().toISOString();
    const schema: DataSchema = { name, pageName, fields, createdAt: now, updatedAt: now, routeAccess, business };
    schemas.push(schema);
    meta.schemas = schemas;
    writePageMeta(dataDir(), userId, pageName, meta);

    const pageDir = getPageDir(dataDir(), userId, pageName);
    await createTable(pageDir, schema);

    const apiBase = `/serve/${userId}/${pageName}/api/${name}`;
    return {
      success: true,
      data: {
        name,
        fields,
        business,
        createdAt: now,
        updatedAt: now,
        endpoints: {
          list: `${apiBase}`,
          create: `${apiBase}`,
          get: `${apiBase}/:id`,
          update: `${apiBase}/:id`,
          delete: `${apiBase}/:id`,
          count: `${apiBase}/count`,
        },
      },
    };
  });

  // PUT /api/schemas/:name — incremental update (ADD COLUMN only)
  app.put("/api/schemas/:name", async (req, reply) => {
    if (deprecated(req)) return gone(reply);
    const { name } = req.params as { name: string };
    const { pageName, fields, business } = req.body as {
      pageName: string;
      fields: Record<string, SchemaField>;
      business?: BusinessMetadata;
    };

    if (!pageName || !fields) {
      return reply.status(400).send({ success: false, error: "pageName and fields are required" });
    }

    const transitionError = validateTransitions(fields, business);
    if (transitionError) {
      return reply.status(400).send({ success: false, error: transitionError });
    }

    const userId = host.userId(req);
    const meta = readPageMeta(dataDir(), userId, pageName);
    if (!meta) {
      return reply.status(404).send({ success: false, error: "Page not found" });
    }

    const schemas = meta.schemas ?? [];
    const existing = schemas.find((s) => s.name === name);
    if (!existing) {
      return reply.status(404).send({ success: false, error: "Schema not found" });
    }

    const pageDir = getPageDir(dataDir(), userId, pageName);
    for (const [fieldName, fieldDef] of Object.entries(fields)) {
      if (!(fieldName in existing.fields)) {
        existing.fields[fieldName] = fieldDef;
        await alterTableAddColumn(pageDir, name, fieldName, fieldDef.type, fieldDef.constraints);
      }
    }

    if (business !== undefined) {
      existing.business = business;
    }

    existing.updatedAt = new Date().toISOString();
    writePageMeta(dataDir(), userId, pageName, meta);

    return {
      success: true,
      data: { name: existing.name, fields: existing.fields, business: existing.business, createdAt: existing.createdAt, updatedAt: existing.updatedAt },
    };
  });

  // DELETE /api/schemas/:name
  app.delete("/api/schemas/:name", async (req, reply) => {
    if (deprecated(req)) return gone(reply);
    const { name } = req.params as { name: string };
    const { pageName } = req.query as { pageName: string };

    if (!pageName) {
      return reply.status(400).send({ success: false, error: "pageName is required" });
    }

    const userId = host.userId(req);
    const meta = readPageMeta(dataDir(), userId, pageName);
    if (!meta) {
      return reply.status(404).send({ success: false, error: "Page not found" });
    }

    const schemas = meta.schemas ?? [];
    const idx = schemas.findIndex((s) => s.name === name);
    if (idx === -1) {
      return reply.status(404).send({ success: false, error: "Schema not found" });
    }

    const pageDir = getPageDir(dataDir(), userId, pageName);
    await dropTable(pageDir, name);

    schemas.splice(idx, 1);
    meta.schemas = schemas;
    writePageMeta(dataDir(), userId, pageName, meta);

    return { success: true, data: { deleted: true, name } };
  });

  // GET /api/schemas?pageName=xxx
  app.get("/api/schemas", async (req, reply) => {
    if (deprecated(req)) return gone(reply);
    const { pageName } = req.query as { pageName: string };

    if (!pageName) {
      return reply.status(400).send({ success: false, error: "pageName is required" });
    }

    const userId = host.userId(req);
    const meta = readPageMeta(dataDir(), userId, pageName);
    if (!meta) {
      return reply.status(404).send({ success: false, error: "Page not found" });
    }

    const schemas = (meta.schemas ?? []).map((s) => ({
      name: s.name,
      fields: s.fields,
      business: s.business,
      routeAccess: s.routeAccess,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
    }));

    return { success: true, data: schemas };
  });
}
