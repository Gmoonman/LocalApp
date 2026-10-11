import type { FastifyInstance } from "fastify";
import { isLoopbackAddress } from "./loopback.cjs";
import type { SetupTokenStore } from "./setup-token-store.cjs";
import type { AccountStore } from "./accounts.cjs";
export interface SetupHost {
  accounts: Pick<AccountStore, "listUsers" | "createInitialAdmin">;
  tokens: Pick<SetupTokenStore, "consume" | "revokeAll">;
  bootstrapApiKey?: string;
  hashPassword(password: string, rounds: number): Promise<string>;
}

const USERNAME_REGEX = /^[a-zA-Z0-9_-]{2,32}$/;
const MIN_PASSWORD_LENGTH = 6;

export async function registerSetupRoutes(app: FastifyInstance, host: SetupHost): Promise<void> {
  app.get("/api/setup/status", async () => ({
    success: true,
    data: { required: host.accounts.listUsers(1, 1).total === 0 },
  }));

  app.post<{ Body: { token?: string; username?: string; password?: string } }>(
    "/api/setup/initialize",
    async (req, reply) => {
      if (!isLoopbackAddress(req.ip)) {
        return reply.status(403).send({ success: false, error: "Setup is only available from loopback" });
      }
      const { token, username, password } = req.body ?? {};
      if (!token || !host.tokens.consume(token)) {
        return reply.status(410).send({ success: false, error: "Setup token has expired or was already used" });
      }
      if (host.accounts.listUsers(1, 1).total !== 0) {
        return reply.status(409).send({ success: false, error: "Setup has already been completed" });
      }
      if (!username || !USERNAME_REGEX.test(username)) {
        return reply.status(400).send({ success: false, error: "Invalid username format" });
      }
      if (!password || password.length < MIN_PASSWORD_LENGTH) {
        return reply.status(400).send({ success: false, error: "Password too short" });
      }

      const passwordHash = await host.hashPassword(password, 10);
      try {
        host.accounts.createInitialAdmin(username, username, passwordHash, host.bootstrapApiKey);
      } catch (error) {
        if (error instanceof Error && error.message === "SETUP_ALREADY_COMPLETED") {
          return reply.status(409).send({ success: false, error: "Setup has already been completed" });
        }
        throw error;
      }
      host.tokens.revokeAll();
      return reply.status(201).send({ success: true });
    },
  );
}
