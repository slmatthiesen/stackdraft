import React from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import * as Sentry from "@sentry/react";
import { App } from "./App.js";
import { initAnalytics } from "./analytics.js";
import { initSentry } from "./sentry.js";
import "./index.css";

// Both are env-gated no-ops until the operator sets the VITE_ tokens at build time. Init
// before render so a crash during mount is captured and a beacon fires on the landing.
initSentry();
initAnalytics();

const root = document.getElementById("root");
if (!root) throw new Error("#root not found");

function ErrorFallback(): JSX.Element {
  return (
    <main className="app">
      <div className="banner banner--error" role="alert">
        <p>Something went wrong loading the page.</p>
        <button type="button" onClick={() => window.location.reload()}>
          Reload
        </button>
      </div>
    </main>
  );
}

createRoot(root).render(
  <React.StrictMode>
    <Sentry.ErrorBoundary fallback={<ErrorFallback />}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </Sentry.ErrorBoundary>
  </React.StrictMode>,
);
