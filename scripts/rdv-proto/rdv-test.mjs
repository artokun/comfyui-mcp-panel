// Protocol tests for the rendezvous broker (hypothesis A + D).
// Node 24 has a global WebSocket, so this needs no dependencies.
const MAIN = Number(process.argv[2] || 8791); // CODE_TTL default
const SHORT = Number(process.argv[3] || 8792); // CODE_TTL = 2s, for the expiry test

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const urlFor = (port, qs) =>
  `ws://127.0.0.1:${port}/comfyui_mcp_panel/rdv?` + new URLSearchParams(qs).toString();

function conn(port, qs) {
  const ws = new WebSocket(urlFor(port, qs));
  ws.binaryType = "arraybuffer";
  const msgs = [];
  let closeCode = null;
  ws.addEventListener("message", (e) => msgs.push(e.data));
  ws.addEventListener("close", (e) => {
    closeCode = e.code;
  });
  const api = {
    msgs,
    get closeCode() {
      return closeCode;
    },
    open: () =>
      new Promise((res, rej) => {
        if (ws.readyState === 1) return res(api);
        ws.addEventListener("open", () => res(api), { once: true });
        ws.addEventListener("error", () => rej(new Error("connect failed")), { once: true });
      }),
    send: (o) => ws.send(typeof o === "string" ? o : JSON.stringify(o)),
    sendBin: (buf) => ws.send(buf),
    waitFor: async (pred, ms = 4000) => {
      const t0 = Date.now();
      for (;;) {
        for (const m of msgs) {
          let o = null;
          if (typeof m === "string") {
            try {
              o = JSON.parse(m);
            } catch {}
          }
          if (pred(o, m)) return o ?? m;
        }
        if (Date.now() - t0 > ms) {
          const seen = msgs.map((x) => (typeof x === "string" ? x.slice(0, 90) : "<binary>"));
          throw new Error("timeout; saw " + JSON.stringify(seen));
        }
        await sleep(30);
      }
    },
    // Assert something does NOT arrive.
    absent: async (pred, ms = 700) => {
      await sleep(ms);
      for (const m of msgs) {
        let o = null;
        if (typeof m === "string") {
          try {
            o = JSON.parse(m);
          } catch {}
        }
        if (pred(o, m)) throw new Error("frame arrived that must not have: " + String(m).slice(0, 120));
      }
      return true;
    },
    close: () => ws.close(),
  };
  return api;
}

const isT = (t) => (o) => o && o.t === t;

async function pairUp(port = MAIN) {
  const panel = await conn(port, { role: "panel" }).open();
  const hello = await panel.waitFor(isT("rdv.hello_ok"));
  const agent = await conn(port, { role: "agent", code: hello.code }).open();
  const ahello = await agent.waitFor(isT("rdv.hello_ok"));
  await panel.waitFor(isT("rdv.peer_joined"));
  return { panel, agent, hello, ahello };
}

const tests = {
  "1. panel is handed a well-formed, unexpired code": async () => {
    const panel = await conn(MAIN, { role: "panel" }).open();
    const h = await panel.waitFor(isT("rdv.hello_ok"));
    if (h.role !== "panel") throw new Error("role=" + h.role);
    if (!/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/.test(h.code)) throw new Error("code=" + h.code);
    if (!h.session) throw new Error("no session id");
    if (!(h.expires_in > 250)) throw new Error("expires_in=" + h.expires_in);
    if (h.paired !== false) throw new Error("paired should be false");
    panel.close();
    return "code " + h.code + ", expires_in " + h.expires_in + "s";
  },

  "2. a wrong code is refused": async () => {
    const bad = await conn(MAIN, { role: "agent", code: "ZZZZ-9999" }).open();
    const e = await bad.waitFor(isT("rdv.error"));
    if (e.code !== "bad_code") throw new Error("code=" + e.code);
    return e.message;
  },

  "3. the right code pairs both sides": async () => {
    const { panel, agent, ahello } = await pairUp();
    if (ahello.role !== "agent") throw new Error("role=" + ahello.role);
    if (!ahello.resume) throw new Error("no resume token issued");
    await agent.waitFor(isT("rdv.peer_joined"));
    panel.close();
    agent.close();
    return "both sides saw peer_joined; resume token issued";
  },

  "4. panel -> agent frames relay verbatim": async () => {
    const { panel, agent } = await pairUp();
    const payload = { t: "user_message", text: "hello agent", n: 42 };
    panel.send(payload);
    const got = await agent.waitFor((o) => o && o.t === "user_message");
    if (got.text !== payload.text || got.n !== 42) throw new Error("mangled: " + JSON.stringify(got));
    panel.close();
    agent.close();
    return "verbatim";
  },

  "5. agent -> panel frames relay verbatim": async () => {
    const { panel, agent } = await pairUp();
    agent.send({ t: "assistant_delta", text: "streaming..." });
    const got = await panel.waitFor((o) => o && o.t === "assistant_delta");
    if (got.text !== "streaming...") throw new Error("mangled");
    panel.close();
    agent.close();
    return "verbatim";
  },

  "6. binary frames relay": async () => {
    const { panel, agent } = await pairUp();
    panel.sendBin(new Uint8Array([1, 2, 3, 250]));
    const got = await agent.waitFor((_o, raw) => raw instanceof ArrayBuffer);
    const bytes = [...new Uint8Array(got)];
    if (bytes.join(",") !== "1,2,3,250") throw new Error("got " + bytes);
    panel.close();
    agent.close();
    return "1,2,3,250 round-tripped";
  },

  "7. the rdv.* namespace is NOT relayed": async () => {
    const { panel, agent } = await pairUp();
    panel.send({ t: "rdv.peer_left", spoofed: true });
    panel.send({ t: "marker" });
    await agent.waitFor((o) => o && o.t === "marker");
    await agent.absent((o) => o && o.t === "rdv.peer_left" && o.spoofed);
    panel.close();
    agent.close();
    return "control frames consumed, payload after it still delivered";
  },

  "8. a pairing code is single-use": async () => {
    const panel = await conn(MAIN, { role: "panel" }).open();
    const h = await panel.waitFor(isT("rdv.hello_ok"));
    const first = await conn(MAIN, { role: "agent", code: h.code }).open();
    await first.waitFor(isT("rdv.hello_ok"));
    const second = await conn(MAIN, { role: "agent", code: h.code }).open();
    const e = await second.waitFor(isT("rdv.error"));
    if (e.code !== "bad_code") throw new Error("expected bad_code, got " + e.code);
    panel.close();
    first.close();
    return "replay refused: " + e.code;
  },

  "9. a second agent cannot displace a live one": async () => {
    const { panel, agent, ahello } = await pairUp();
    const intruder = await conn(MAIN, { role: "agent", resume: ahello.resume }).open();
    const e = await intruder.waitFor(isT("rdv.error"));
    if (e.code !== "agent_present") throw new Error("code=" + e.code);
    panel.close();
    agent.close();
    return e.code;
  },

  "10. a disconnect notifies the peer": async () => {
    const { panel, agent } = await pairUp();
    agent.close();
    const gone = await panel.waitFor(isT("rdv.peer_left"));
    if (gone.role !== "agent") throw new Error("role=" + gone.role);
    panel.close();
    return "panel saw peer_left(agent)";
  },

  "11. the agent resumes without re-pairing": async () => {
    const { panel, agent, ahello } = await pairUp();
    agent.close();
    await panel.waitFor(isT("rdv.peer_left"));
    const back = await conn(MAIN, { role: "agent", resume: ahello.resume }).open();
    const h2 = await back.waitFor(isT("rdv.hello_ok"));
    if (h2.session !== ahello.session) throw new Error("different session");
    panel.send({ t: "after_resume" });
    await back.waitFor((o) => o && o.t === "after_resume");
    panel.close();
    back.close();
    return "same session, relay live again";
  },

  "12. an expired code is refused": async () => {
    const panel = await conn(SHORT, { role: "panel" }).open();
    const h = await panel.waitFor(isT("rdv.hello_ok"));
    await sleep(2600); // TTL on this harness is 2s
    const late = await conn(SHORT, { role: "agent", code: h.code }).open();
    const e = await late.waitFor(isT("rdv.error"));
    if (e.code !== "bad_code") throw new Error("code=" + e.code);
    panel.close();
    return "expired after TTL: " + e.code;
  },

  "13. an unknown resume token is refused": async () => {
    const bogus = await conn(MAIN, { role: "agent", resume: "not-a-real-token" }).open();
    const e = await bogus.waitFor(isT("rdv.error"));
    if (e.code !== "bad_resume") throw new Error("code=" + e.code);
    return e.code;
  },

  "14. a bad role is rejected before the upgrade": async () => {
    const res = await fetch(`http://127.0.0.1:${MAIN}/comfyui_mcp_panel/rdv?role=wat`);
    if (res.status !== 400) throw new Error("status=" + res.status);
    return "HTTP 400";
  },

  "15. status exposes counts and never secrets": async () => {
    const res = await fetch(`http://127.0.0.1:${MAIN}/comfyui_mcp_panel/rdv_status`);
    const j = await res.json();
    const body = JSON.stringify(j);
    if (/code|token|resume/i.test(body.replace(/codes_live/g, ""))) {
      throw new Error("status leaked something: " + body);
    }
    if (typeof j.sessions !== "number") throw new Error("no session count");
    return body;
  },
};

const run = async () => {
  let pass = 0;
  const fails = [];
  for (const [name, fn] of Object.entries(tests)) {
    try {
      const note = await fn();
      pass++;
      console.log("  PASS  " + name + (note ? "  -- " + note : ""));
    } catch (err) {
      fails.push(name);
      console.log("  FAIL  " + name + "\n          " + err.message);
    }
  }
  console.log(`\n${pass}/${Object.keys(tests).length} passed`);
  process.exit(fails.length ? 1 : 0);
};
run();
