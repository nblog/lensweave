import { Archive, Clock3, Globe2 } from "lucide-react";
import type { AssetKind, AssetScope } from "../api/client";

export const ASSET_KIND_OPTIONS: AssetKind[] = ["character", "prop", "scene"];
export const ASSET_SCOPE_OPTIONS: AssetScope[] = ["global", "fixed", "temporary"];

export function assetScopeIcon(scope: AssetScope, size = 15) {
  switch (scope) {
    case "global":
      return <Globe2 size={size} aria-hidden />;
    case "fixed":
      return <Archive size={size} aria-hidden />;
    case "temporary":
      return <Clock3 size={size} aria-hidden />;
  }
}

export function assetKindLabelSuffix(kind: AssetKind): string {
  switch (kind) {
    case "character":
      return "Character";
    case "scene":
      return "Scene";
    case "prop":
      return "Prop";
  }
}

export function assetScopeLabelSuffix(scope: AssetScope): string {
  switch (scope) {
    case "global":
      return "Global";
    case "fixed":
      return "Fixed";
    case "temporary":
      return "Temporary";
  }
}
