import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router-dom";
import "./i18n";
import "./index.css";
import App from "./App.tsx";
import { ConfirmProvider } from "./components/ConfirmDialog";

const queryClient = new QueryClient();

// Dev-only: register WebMCP canvas tools + local relay bridge (docs/06 §5).
if (import.meta.env.DEV) {
  void import("./mcp/register").then((m) => m.startWebMcp());
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <QueryClientProvider client={queryClient}>
        <ConfirmProvider>
          <App />
        </ConfirmProvider>
      </QueryClientProvider>
    </BrowserRouter>
  </StrictMode>,
);
