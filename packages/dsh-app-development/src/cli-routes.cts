import { FastifyInstance, FastifyReply } from "fastify";
import {
  findCliAsset,
  ReleaseManifestClient,
  ReleaseManifestError,
  type ReleaseManifestProvider,
} from "./release-manifest.cjs";

export interface CliRouteOptions {
  manifestUrl: string;
  manifestProvider?: ReleaseManifestProvider;
}

export function createCliRoutes(options: CliRouteOptions) {
  return async function cliRoutesPlugin(app: FastifyInstance) {
    const provider = options.manifestProvider ?? new ReleaseManifestClient({
      manifestUrl: options.manifestUrl,
    });

    app.get("/api/cli/version", async (_req, reply) => {
      try {
        const snapshot = await provider.get();
        return {
          ...snapshot.manifest,
          fetchedAt: new Date(snapshot.fetchedAt).toISOString(),
          stale: snapshot.stale,
        };
      } catch (error) {
        return sendManifestError(reply, error);
      }
    });

    app.get<{ Querystring: { os: string; arch: string; version?: string } }>(
      "/api/cli/download",
      async (req, reply) => {
        const { os, arch, version } = req.query;
        if (!os || !arch) {
          return reply.status(400).send({
            success: false,
            code: "CLI_TARGET_REQUIRED",
            error: "os and arch query params are required",
          });
        }

        try {
          const snapshot = await provider.get();
          const selectedVersion = version || snapshot.manifest.latest;
          const asset = findCliAsset(snapshot.manifest, {
            version: selectedVersion,
            os,
            arch,
          });
          if (!asset) {
            return reply.status(404).send({
              success: false,
              code: "CLI_ASSET_NOT_FOUND",
              error: `No CLI asset for ${selectedVersion}/${os}/${arch}`,
            });
          }

          return reply
            .status(307)
            .header("Location", asset.url)
            .header("Content-Disposition", `attachment; filename="${asset.filename}"`)
            .header("X-LocalApp-Asset-Size", String(asset.size))
            .header("X-LocalApp-Asset-SHA256", asset.sha256)
            .send();
        } catch (error) {
          return sendManifestError(reply, error);
        }
      },
    );
  };
}

function sendManifestError(reply: FastifyReply, error: unknown) {
  if (error instanceof ReleaseManifestError) {
    const status = error.code === "CLI_RELEASE_MANIFEST_UNAVAILABLE" ? 503 : 502;
    return reply.status(status).send({
      success: false,
      code: error.code,
      error: error.message,
    });
  }
  return reply.status(503).send({
    success: false,
    code: "CLI_RELEASE_MANIFEST_UNAVAILABLE",
    error: "No validated CLI release manifest is currently available",
  });
}
