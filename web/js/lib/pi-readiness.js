// Pi credentials have provider-specific validation in the MCP. A generic bridge
// `ready` acknowledgement only proves its dispatcher progressed; before the MCP
// has sent its authoritative `backends` snapshot it must not override Pi's
// conservative panel-local state.
export function readyAckCanPromoteBackend(backend, piBackendsReadinessReceived) {
  return backend !== "pi" || piBackendsReadinessReceived === true;
}
