// Prototype agent side (hypothesis A + D): the orchestrator dials OUT to ComfyUI.
// No inbound listener, no tunnel, no advertised URL. Node 24 global WebSocket, no deps.
//   node rdv-agent.mjs <comfyui-base-url> <PAIRING-CODE>
const [base, code] = process.argv.slice(2);
const u = new URL(base);
u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
u.pathname = "/comfyui_mcp_panel/rdv";
u.search = new URLSearchParams({ role: "agent", code }).toString();

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
log("dialing", u.toString().replace(/code=[^&]*/, "code=<redacted>"));

const ws = new WebSocket(u);
ws.addEventListener("open", () => log("socket open (outbound only)"));
ws.addEventListener("error", () => log("SOCKET ERROR"));
ws.addEventListener("close", (e) => {
  log("closed code=" + e.code);
  process.exit(0);
});

ws.addEventListener("message", (e) => {
  let o = null;
  try {
    o = JSON.parse(e.data);
  } catch {}
  if (o && typeof o.t === "string" && o.t.startsWith("rdv.")) {
    log("control:", JSON.stringify(o).replace(/"resume":"[^"]*"/, '"resume":"<redacted>"'));
    if (o.t === "rdv.hello_ok") {
      // Prove agent -> panel without waiting to be spoken to first.
      ws.send(JSON.stringify({ t: "assistant_delta", text: "hello from the agent process" }));
    }
    return;
  }
  log("payload from panel:", JSON.stringify(o));
  // Prove panel -> agent -> panel round trip.
  ws.send(JSON.stringify({ t: "agent_echo", saw: o }));
});

setTimeout(() => {
  log("done (idle timeout)");
  ws.close();
}, 45000);
