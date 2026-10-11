import type { FastifyInstance } from "fastify";
import type { AgentEnvironment } from "./agent-environment.cjs";
import { readPythonEnvironment, selectPythonEnvironment, createPythonEnvironment, installDocumentPythonDependencies } from "./python-environment.cjs";
export interface EnvironmentRoutesHost { dataDir: string; checkEnvironment(): Promise<AgentEnvironment> }
/** Register in an administrator-authenticated HTTP scope. */
export async function registerEnvironmentRoutes(app: FastifyInstance, host: EnvironmentRoutesHost): Promise<void> {
    app.get("/api/system/agent-environment", async () => ({ success: true, data: await host.checkEnvironment() }));

    app.get("/api/system/python-environment", async () => ({ success: true, data: { environment: readPythonEnvironment(host.dataDir) ?? null } }));
    app.put<{ Body: { executable: string } }>("/api/system/python-environment", async (req, reply) => {
      try { return { success: true, data: { environment: await selectPythonEnvironment(host.dataDir, req.body?.executable) } }; }
      catch(error) { return reply.status(400).send({ success: false, error: error instanceof Error ? error.message.slice(0,2000) : "选择 Python 环境失败" }); }
    });
    app.post<{ Body: { baseExecutable: string; installDocuments?: boolean } }>("/api/system/python-environment/create", async (req, reply) => {
      try { return { success: true, data: { environment: await createPythonEnvironment(host.dataDir, req.body?.baseExecutable, req.body?.installDocuments === true) } }; }
      catch(error) { return reply.status(400).send({ success: false, error: error instanceof Error ? error.message.slice(0,2000) : "创建 Python 环境失败" }); }
    });
    app.post("/api/system/python-environment/install-document-dependencies", async (_req, reply) => {
      try { return { success: true, data: { environment: await installDocumentPythonDependencies(host.dataDir) } }; }
      catch(error) { return reply.status(400).send({ success: false, error: error instanceof Error ? error.message.slice(0,2000) : "安装依赖失败" }); }
    });

}
