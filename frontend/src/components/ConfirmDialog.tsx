/**
 * App-wide confirmation dialog. A single provider renders one modal and exposes
 * an imperative `useConfirm()` (see ./confirm-context) that returns a
 * Promise<boolean>, so destructive or hard-to-reverse actions (deleting an
 * asset, overwriting an uploaded image, deleting a canvas node) can
 * `await confirm(...)` inline instead of each site hand-rolling its own modal.
 * Keeps the guardrail consistent and DRY.
 */
import {
  useCallback,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, X } from "lucide-react";
import {
  ConfirmContext,
  type ConfirmFn,
  type ConfirmOptions,
} from "./confirm-context";

interface PendingConfirm extends ConfirmOptions {
  resolve: (value: boolean) => void;
}

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const [pending, setPending] = useState<PendingConfirm | null>(null);

  const confirm = useCallback<ConfirmFn>((options) => {
    return new Promise<boolean>((resolve) => {
      setPending({ ...options, resolve });
    });
  }, []);

  const settle = useCallback((value: boolean) => {
    setPending((current) => {
      current?.resolve(value);
      return null;
    });
  }, []);

  const value = useMemo(() => confirm, [confirm]);

  return (
    <ConfirmContext.Provider value={value}>
      {children}
      {pending && (
        <div
          className="confirm-dialog"
          role="dialog"
          aria-modal="true"
          aria-label={pending.title}
          onMouseDown={() => settle(false)}
        >
          <div
            className="confirm-panel"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <button
              className="confirm-close"
              type="button"
              onClick={() => settle(false)}
              aria-label={pending.cancelLabel ?? t("confirm.cancel")}
            >
              <X size={18} aria-hidden />
            </button>
            <div className={`confirm-icon${pending.danger ? " danger" : ""}`}>
              <AlertTriangle size={22} aria-hidden />
            </div>
            <h3 className="confirm-title">{pending.title}</h3>
            {pending.message && (
              <p className="confirm-message">{pending.message}</p>
            )}
            <div className="confirm-actions">
              <button type="button" onClick={() => settle(false)}>
                {pending.cancelLabel ?? t("confirm.cancel")}
              </button>
              <button
                type="button"
                className={pending.danger ? "danger" : "primary"}
                autoFocus
                onClick={() => settle(true)}
              >
                {pending.confirmLabel ?? t("confirm.confirm")}
              </button>
            </div>
          </div>
        </div>
      )}
    </ConfirmContext.Provider>
  );
}
