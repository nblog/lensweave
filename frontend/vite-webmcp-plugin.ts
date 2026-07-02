/**
 * Local Vite plugin wrapping webmcp-nexus-core's transformCode (docs/06 §1).
 *
 * Why not use vite-plugin-webmcp-nexus directly: on Windows that plugin matches
 * its `include` globs against path.relative(root, id), which returns backslash
 * paths ("src\\mcp\\tools.ts"), while its glob->regex only matches "/". The
 * result is that no file matches and __webmcpSchema is never injected. This
 * wrapper normalizes separators before matching, then normalizes generated
 * schemas so array fields always have items. rejects MCP tools whose JSON
 * Schema contains a bare { type: "array" }, and webmcp-nexus-core 0.1.x
 * can emit that shape for object-array parameters such as assetRefs.
 */
import nodePath from "node:path";

import { transformCode } from "webmcp-nexus-core";
import type { Plugin } from "vite";

export interface WebMcpPluginOptions {
  /** glob patterns (forward-slash), default ['src/mcp/**\/*.ts']. */
  include?: string[];
}

function toRegex(pattern: string): RegExp {
  const body = pattern
    .replace(/\./g, "\\.")
    .replace(/\*\*\//g, "(?:.*/)?")
    .replace(/\*/g, "[^/]*");
  return new RegExp("^" + body + "$");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeArrayItems(schema: unknown): void {
  if (!isRecord(schema)) return;

  if (schema.type === "array" && !("items" in schema)) {
    schema.items = { type: "object" };
  }

  normalizeArrayItems(schema.items);

  if (isRecord(schema.properties)) {
    for (const child of Object.values(schema.properties)) {
      normalizeArrayItems(child);
    }
  }
}

function findJsonObjectEnd(code: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < code.length; i += 1) {
    const char = code[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }

  return -1;
}

function normalizeInjectedSchemas(code: string): string {
  const assignmentPattern = /\.__webmcpSchema\s*=\s*\{/g;
  let output = "";
  let cursor = 0;

  for (const match of code.matchAll(assignmentPattern)) {
    const openBrace = code.indexOf("{", match.index);
    if (openBrace < 0) continue;

    const end = findJsonObjectEnd(code, openBrace);
    if (end < 0) continue;

    const rawSchema = code.slice(openBrace, end);
    try {
      const schema = JSON.parse(rawSchema);
      normalizeArrayItems(schema.inputSchema);
      output += code.slice(cursor, openBrace) + JSON.stringify(schema, null, 2);
      cursor = end;
    } catch {
      // Keep the generated code unchanged if it ever stops being plain JSON.
    }
  }

  return cursor === 0 ? code : output + code.slice(cursor);
}

export function webmcpSchemaPlugin(
  options: WebMcpPluginOptions = {},
): Plugin {
  const include = options.include ?? ["src/mcp/**/*.ts"];
  const matchers = include.map(toRegex);
  let projectRoot = "";

  return {
    name: "webmcp-schema-local",
    enforce: "pre",
    configResolved(config) {
      projectRoot = config.root;
    },
    transform(code, id) {
      const cleanId = id.split("?")[0];
      if (!/\.[jt]sx?$/.test(cleanId)) return null;
      // Normalize to forward slashes so include matching is OS-independent.
      const relativePath = nodePath
        .relative(projectRoot, cleanId)
        .replace(/\\/g, "/");
      if (!matchers.some((re) => re.test(relativePath))) return null;
      try {
        const result = transformCode(code, cleanId, { projectRoot });
        if (result.transformed) {
          return { code: normalizeInjectedSchemas(result.code), map: null };
        }
      } catch (err) {
        this.warn(
          `[webmcp] transform failed for ${cleanId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      return null;
    },
  };
}
