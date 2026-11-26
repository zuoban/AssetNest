import type { FastifyInstance } from "fastify";
import { ZodError } from "zod";
import type { ApiErrorBody, ErrorCode } from "../../shared/types.js";

export class AppError extends Error {
  readonly statusCode: number;
  readonly code: ErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(
    statusCode: number,
    code: ErrorCode,
    message: string,
    details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "AppError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err, _request, reply) => {
    if (err instanceof AppError) {
      const body: ApiErrorBody = {
        error: {
          code: err.code,
          message: err.message,
          ...(err.details ? { details: err.details } : {})
        }
      };
      return reply.status(err.statusCode).send(body);
    }

    if (err instanceof ZodError) {
      const body: ApiErrorBody = {
        error: {
          code: "VALIDATION_ERROR",
          message: err.issues[0]?.message || "请求参数校验失败",
          details: {
            issues: err.issues.map((issue) => ({
              path: issue.path.join("."),
              message: issue.message
            }))
          }
        }
      };
      return reply.status(400).send(body);
    }

    const fastifyErr = err as { statusCode?: number; code?: string; message?: string };
    if (fastifyErr.statusCode === 429) {
      const body: ApiErrorBody = {
        error: {
          code: "RATE_LIMITED",
          message: "请求过于频繁，请稍后再试"
        }
      };
      return reply.status(429).send(body);
    }

    if (fastifyErr.statusCode && fastifyErr.statusCode >= 400 && fastifyErr.statusCode < 500) {
      const body: ApiErrorBody = {
        error: {
          code: "VALIDATION_ERROR",
          message: fastifyErr.message || "请求格式错误"
        }
      };
      return reply.status(fastifyErr.statusCode).send(body);
    }

    app.log.error({ err }, "Unhandled server error");
    const body: ApiErrorBody = {
      error: {
        code: "INTERNAL_ERROR",
        message: "服务器内部错误，请查看服务日志"
      }
    };
    return reply.status(500).send(body);
  });
}
