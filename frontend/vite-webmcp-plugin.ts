/**
 * Local Vite plugin wrapping webmcp-nexus-core's transformCode (docs/06 §1).
 *
 * Why not use vite-plugin-webmcp-nexus directly: on Windows that plugin matches
 * its `include` globs against path.relative(root, id), which returns backslash
 * paths ("src\\mcp\\tools.ts"), while its glob->regex only matches "/". The
 * result is that no file matches and __webmcpSchema is never injected. This
 * wrapper normalizes separators before matching but otherwise delegates to the
 * exact same official extraction logic, so behaviour is identical cross-OS.
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
        if (result.transformed) return { code: result.code, map: null };
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
