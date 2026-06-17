/**
 * Confirm context + hook, split from the provider component so the provider
 * file only exports a component (react-refresh constraint). `useConfirm()`
 * returns an imperative confirm() resolving true when the user accepts.
 */
import { createContext, useContext } from "react";

export interface ConfirmOptions {
  title: string;
  message?: string;
  /** Confirm button label; defaults to the shared "confirm" string. */
  confirmLabel?: string;
  /** Cancel button label; defaults to the shared "cancel" string. */
  cancelLabel?: string;
  /** Style the confirm button as destructive (red). */
  danger?: boolean;
}

export type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>;

export const ConfirmContext = createContext<ConfirmFn | null>(null);

export function useConfirm(): ConfirmFn {
  const ctx = useContext(ConfirmContext);
  if (!ctx) {
    throw new Error("useConfirm must be used within a ConfirmProvider");
  }
  return ctx;
}
