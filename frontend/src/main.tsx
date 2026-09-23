import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import { ConfirmStartPage } from "./components/ConfirmStartPage.tsx";
import "./styles/global.css";

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("#root not found");

// Opened by scanning the decoy QR — must work with no dashboard session at
// all, so it's rendered standalone instead of going through App's auth gate.
const confirmMatch = window.location.pathname.match(/^\/confirm\/([^/]+)\/?$/);

createRoot(rootEl).render(<StrictMode>{confirmMatch ? <ConfirmStartPage token={confirmMatch[1]!} /> : <App />}</StrictMode>);
