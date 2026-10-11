import { createUserApplicationManagement } from "@localapp/dsh-app-platform/user-applications";
import { registerAdministratorApplications, type AdministratorApplicationsHost } from "@localapp/dsh-app-platform/admin-applications-routes";
import { registerAdministratorAccounts, type AdministratorAccountsHost } from "@localapp/dsh-multiuser/admin-accounts-routes";
import { accountServices } from "../lib/meta-sqlite.js";
import { FastifyInstance } from "fastify";
import { adminAuth } from "../plugins/auth.js";
import bcrypt from "bcryptjs";
import { listUsers, getDb, BOOTSTRAP_USER_ID, isProtectedUserId } from "../lib/meta-sqlite.js";
import { generateTemporaryPassword } from "../lib/credentials.js";
import { deleteAppObjects } from "../lib/s3-client.js";

export function createAdministratorAccountsHost(dataDir: string): AdministratorAccountsHost {
  return {
    ...accountServices, bootstrapUserId: BOOTSTRAP_USER_ID, userId: req => req.userId,
    isProtectedUserId, generateTemporaryPassword, hashPassword: (password, rounds) => bcrypt.hash(password, rounds),
    countAdministrators: accountServices.accounts.countAdministrators.bind(accountServices.accounts),
    ...createUserApplicationManagement({ dataDir, deleteAppObjects }),

  };
}

export async function adminRoutes(app: FastifyInstance) {
  adminAuth(app);
  await registerAdministratorAccounts(app, createAdministratorAccountsHost(app.config.dataDir));
  await adminApplicationRoutes(app);
}

export function createAdministratorApplicationsHost(dataDir: string): AdministratorApplicationsHost {
  return { dataDir, database: getDb, totalUsers: () => listUsers(1, 1).total, deleteAppObjects };
}

export async function adminApplicationRoutes(app: FastifyInstance) {
  await registerAdministratorApplications(app, createAdministratorApplicationsHost(app.config.dataDir));
}
