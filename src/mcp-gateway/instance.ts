import type { GatewayServer } from './http-server.js';

/**
 * Module-level singleton for the running gateway. Set by the orchestrator
 * at startup so container-runner can issue tokens without parameter-passing
 * through every call site.
 */

let instance: GatewayServer | null = null;

export function setGatewayInstance(g: GatewayServer | null): void {
  instance = g;
}

export function getGatewayInstance(): GatewayServer | null {
  return instance;
}
