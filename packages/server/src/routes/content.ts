import type { FastifyRequest, FastifyReply } from "fastify";
import { handleContentUpload as upload, handleContentRead as read } from "@localapp/dsh-app-platform/content-handler";
import { putObject, getObject } from "../lib/s3-client.js";

export function handleContentUpload(req: FastifyRequest, reply: FastifyReply, owner: string, name: string, pageDir?: string) {
  return upload(req, reply, owner, name, pageDir, { putObject, getObject });
}

export function handleContentRead(req: FastifyRequest, reply: FastifyReply, owner: string, name: string, key: string) {
  return read(req, reply, owner, name, key, { putObject, getObject });
}
