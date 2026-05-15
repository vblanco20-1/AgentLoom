import { createContext, useContext } from "react";
import type { RunWsClient } from "../api/wsClient";

// React context that propagates the page-level RunWsClient down to nested
// components (AgentCard, PermissionPanel) so they can fire abort / retry /
// permission-reply messages without prop-drilling.
export const WsContext = createContext<RunWsClient | null>(null);

export function useWs(): RunWsClient | null {
  return useContext(WsContext);
}
