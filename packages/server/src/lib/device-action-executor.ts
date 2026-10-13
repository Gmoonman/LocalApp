import fs from "node:fs";
import path from "node:path";
import { executeDeviceAction as execute, DeviceActionExecutionError, type ExecuteDeviceActionInput } from "@localapp/dsh-device-services/device-action-executor";
export * from "@localapp/dsh-device-services/device-action-executor";
export async function executeDeviceAction(input: ExecuteDeviceActionInput): Promise<unknown> {
  return execute({ ...input, runnerPath: input.runnerPath ?? findRunnerPath() });
}
function findRunnerPath(): string {
  const candidates = [
    process.env.LOCALAPP_RUNNER_PATH,
    path.resolve(__dirname, "../../runner/localapp-runner.mjs"),
    path.resolve(__dirname, "../runner/localapp-runner.mjs"),
  ].filter((candidate): candidate is string => Boolean(candidate));
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) throw new DeviceActionExecutionError("DEVICE_ACTION_RUNNER_UNAVAILABLE");
  return found;
}
