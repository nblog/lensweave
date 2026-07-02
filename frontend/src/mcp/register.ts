/**
 * WebMCP registration (docs/06 §4) — register the canvas command tools with
 * navigator.modelContext at app startup. Dev/experimental only: gated on
 * import.meta.env.DEV so production builds neither register tools nor load the
 * local relay bridge (docs/06 §5).
 */
import { registerGlobalTools } from "webmcp-nexus-sdk";

import * as tools from "./tools";

const RELAY_EMBED_SRC =
  "https://cdn.jsdelivr.net/npm/@mcp-b/webmcp-local-relay@3/dist/browser/embed.js";

let started = false;

/** Register tools and inject the local relay bridge. Idempotent. */
export function startWebMcp(): void {
  if (started || typeof window === "undefined") return;
  started = true;

  registerGlobalTools(tools);

  if (!document.querySelector("script[data-webmcp-relay-embed]")) {
    const script = document.createElement("script");
    script.src = RELAY_EMBED_SRC;
    script.async = true;
    script.dataset.webmcpRelayEmbed = "true";
    document.head.appendChild(script);
  }
}
