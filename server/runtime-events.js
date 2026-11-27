// 页面自己报上来的状态，广播时带上 origin，方便页面认出回声。
// 控制接口、外部点歌、歌单播放这些来源不带 clientId，广播里就没有 origin。

export function stateBroadcast(runtime, clientId) {
  const event = { type: 'state', runtime };
  if (typeof clientId === 'string' && clientId.trim()) event.origin = clientId.trim();
  return event;
}

export function progressBroadcast(runtime, clientId) {
  const event = {
    type: 'progress',
    currentTime: Number.isFinite(runtime?.currentTime) ? runtime.currentTime : 0,
    duration: Number.isFinite(runtime?.duration) ? runtime.duration : 0,
    paused: Boolean(runtime?.paused),
    index: Number.isFinite(runtime?.index) ? runtime.index : 0,
  };
  if (typeof clientId === 'string' && clientId.trim()) event.origin = clientId.trim();
  return event;
}

export function leaderBroadcast(leader) {
  return {
    type: 'leader',
    leader: leader
      ? { clientId: leader.clientId, kind: leader.kind, claimed: Boolean(leader.claimed) }
      : null,
  };
}

export function normalizeClientKind(kind) {
  return kind === 'electron' ? 'electron' : 'pwa';
}

// /stream 连接身份注册与单点播放权威选举：
// 有人显式认领（「在此设备播放」）→ 最新认领的连接当 leader，不看类型；
// 否则有 electron 连接 → 最新连接的 electron 当 leader；否则最早连接的 pwa 当 leader。
// 认领随连接存活：断开即释放，重新选举。
export function createStreamRegistry() {
  const entries = new Map();
  let nextSeq = 0;
  let nextClaimSeq = 0;

  function electEntry() {
    let latestClaimed = null;
    let latestElectron = null;
    let earliestPwa = null;
    for (const entry of entries.values()) {
      // 独立播放客户端（如手机独立模式）不参与全局单点选举，既不抢电脑出声也不被电脑静音。
      if (entry.standalone) continue;
      if (entry.claimed) {
        if (!latestClaimed || entry.claimSeq > latestClaimed.claimSeq) {
          latestClaimed = entry;
        }
        continue;
      }
      if (entry.kind === 'electron') {
        if (!latestElectron || entry.seq > latestElectron.seq) {
          latestElectron = entry;
        }
      } else if (!earliestPwa || entry.seq < earliestPwa.seq) {
        earliestPwa = entry;
      }
    }
    return latestClaimed || latestElectron || earliestPwa || null;
  }

  function toLeaderView(entry) {
    return entry
      ? { clientId: entry.clientId, kind: entry.kind, claimed: Boolean(entry.claimed) }
      : null;
  }

  function connect(ws) {
    const seq = ++nextSeq;
    const entry = {
      ws,
      seq,
      clientId: `anon-${seq}`,
      kind: 'pwa',
      identified: false,
      standalone: false,
      claimed: false,
      claimSeq: 0,
    };
    entries.set(ws, entry);
    return { entry, leader: toLeaderView(electEntry()) };
  }

  function identify(ws, msg = {}) {
    const entry = entries.get(ws);
    if (!entry) return toLeaderView(electEntry());
    const rawId = typeof msg?.clientId === 'string' ? msg.clientId.trim() : '';
    if (rawId) entry.clientId = rawId;
    entry.kind = normalizeClientKind(msg?.kind);
    entry.standalone = Boolean(msg?.standalone);
    if (entry.standalone) {
      entry.claimed = false;
      entry.claimSeq = 0;
    }
    entry.identified = true;
    return toLeaderView(electEntry());
  }

  // 显式认领/归还播放权（「在此设备播放 / 归还播放权」）。
  // 必须是连接上的独立动作，不随 identify 走：断线重连只重新 identify，
  // 不会静默复活旧意图抢走别人的有效认领。
  // want=true 认领；want=false 归还。认领只跟这条连接走，断开自动归还；
  // 后到认领接前到者，保证当前有效认领单一。
  function claim(ws, want) {
    const entry = entries.get(ws);
    if (!entry) return toLeaderView(electEntry());
    if (want) {
      entry.claimed = true;
      entry.claimSeq = ++nextClaimSeq;
    } else {
      entry.claimed = false;
      entry.claimSeq = 0;
    }
    return toLeaderView(electEntry());
  }

  function disconnect(ws) {
    entries.delete(ws);
    return toLeaderView(electEntry());
  }

  function leader() {
    return toLeaderView(electEntry());
  }

  function isLeader(ws) {
    const current = electEntry();
    return Boolean(current && current.ws === ws);
  }

  function canReportState(clientId) {
    const id = typeof clientId === 'string' ? clientId.trim() : '';
    if (!id || entries.size === 0) return true;
    const current = electEntry();
    if (!current) return true;
    if (current.clientId === id) return true;
    // 若该 clientId 属于已知非 leader 连接，拒绝其状态回写以免 follower 覆盖 leader。
    for (const entry of entries.values()) {
      if (entry.clientId === id) return false;
    }
    return true;
  }

  function clientsForId(clientId) {
    const id = typeof clientId === 'string' ? clientId.trim() : '';
    if (!id) return [];
    const matched = [];
    for (const entry of entries.values()) {
      if (entry.clientId === id) matched.push(entry.ws);
    }
    return matched;
  }

  function snapshot() {
    const current = electEntry();
    return {
      leader: toLeaderView(current),
      listeners: Array.from(entries.values(), entry => ({
        clientId: entry.clientId,
        kind: entry.kind,
        ...(entry.standalone ? { standalone: true } : {}),
        claimed: Boolean(entry.claimed),
        leader: entry === current,
      })),
    };
  }

  return {
    connect,
    identify,
    claim,
    disconnect,
    leader,
    isLeader,
    canReportState,
    getClient: ws => entries.get(ws) || null,
    clientsForId,
    size: () => entries.size,
    clients: () => entries.keys(),
    snapshot,
  };
}
