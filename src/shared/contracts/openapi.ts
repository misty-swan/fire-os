import { z } from "zod";
import { ErrorEnvelope, SuccessMeta, errorCodes } from "./common";
import { authLibrary } from "./auth";
import { apiDef, apiIds, type ApiId } from "./registry";

type Json = Record<string, unknown>;

const jsonSchema = (schema: z.ZodType, io: "input" | "output"): Json => {
  const out = z.toJSONSchema(schema, { target: "draft-2020-12", io, unrepresentable: "any" }) as Json;
  delete out.$schema;
  return out;
};

/** 'a/:id/b' → 'a/{id}/b' */
const toOpenApiPath = (path: string) => path.replace(/:(\w+)/g, "{$1}");

function parametersOf(location: "path" | "query" | "header", schema: z.ZodType | undefined): Json[] {
  if (!schema) return [];
  const js = jsonSchema(schema, "input");
  const required = new Set((js.required as string[] | undefined) ?? []);
  const props = (js.properties as Record<string, Json> | undefined) ?? {};
  return Object.entries(props).map(([name, s]) => ({
    name,
    in: location,
    required: location === "path" ? true : required.has(name),
    schema: s,
  }));
}

const errorStatuses = (kind: string, id: ApiId): number[] => {
  const base = [400, 401, 403, 404, 429, 500, 503];
  const withConflict = kind === "mutation" || kind === "job" || kind === "noContent" || id === "API-10" || id === "API-70" || id === "API-80";
  return withConflict ? [...base, 409, 422].sort() : base;
};

/** 台帳(registry)からOpenAPI 3.1文書を生成する。入力・出力型と同じZodスキーマが唯一の元。 */
export function buildOpenApi(): Json {
  const paths: Record<string, Json> = {};
  const external: Json = {};

  for (const id of apiIds) {
    const def = apiDef(id);
    const shape = (def.request as unknown as { shape?: Record<string, z.ZodType> }).shape ?? {};
    const common = { operationId: id, summary: `${id} ${def.method} ${def.path}`, "x-permission": def.permission, "x-kind": def.kind, "x-provisional-response": !!def.provisional };

    if (def.kind === "external") {
      external[id] = {
        ...common,
        path: def.path,
        note: "認証ライブラリ(D04固定版)の公式スキーマに従う。業務envelope外",
        library: { name: authLibrary.name, version: authLibrary.version },
        basePath: authLibrary.basePath,
        endpoints: authLibrary.endpoints,
      };
      continue;
    }

    const responses: Record<string, Json> = {};
    for (const status of def.success) {
      if (status === 204) responses["204"] = { description: "本文なし" };
      else if (def.kind === "binary") responses[String(status)] = { description: "バイナリ/CSV/stream（JSON envelope外）" };
      else {
        responses[String(status)] = {
          description: status === 202 ? "永続jobを受け付けた（業務完了ではない）" : "成功",
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["data", "meta"],
                additionalProperties: false,
                properties: { data: jsonSchema(def.response, "output"), meta: { $ref: "#/components/schemas/SuccessMeta" } },
              },
            },
          },
        };
      }
    }
    for (const status of errorStatuses(def.kind, id)) {
      responses[String(status)] = {
        description: "エラー",
        content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorEnvelope" } } },
      };
    }

    const operation: Json = {
      ...common,
      parameters: [
        ...parametersOf("path", shape.params),
        ...parametersOf("query", shape.query),
        ...parametersOf("header", shape.headers),
      ],
      responses,
    };
    if (shape.body) {
      operation.requestBody = { required: true, content: { "application/json": { schema: jsonSchema(shape.body, "input") } } };
    }

    const key = `/api/v1${toOpenApiPath(def.path)}`;
    (paths[key] ??= {})[def.method.toLowerCase()] = operation;
  }

  return {
    openapi: "3.1.0",
    info: {
      title: "FireOS API",
      version: "0.3.0-ph0",
      description: "T002生成物。正本は src/shared/contracts（Zod）。編集せず `npm run generate:contracts` で再生成する。",
    },
    servers: [{ url: "/" }],
    paths,
    "x-external-apis": external,
    components: {
      schemas: {
        SuccessMeta: jsonSchema(SuccessMeta, "output"),
        ErrorEnvelope: jsonSchema(ErrorEnvelope, "output"),
        ErrorCode: { type: "string", enum: [...errorCodes] },
      },
    },
  };
}
