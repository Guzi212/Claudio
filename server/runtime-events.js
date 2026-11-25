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
      claimed: false,
      claimSeq: 0,
    };
    entries.set(ws, entry);
    return { entry, leader: toLeaderView(electEntry()) };
  }

  // claim=true 认领播放权（「在此设备播放」），claim=false 归还。
  // 认领只跟这条连接走：断开自动归还；重复 claim 刷新次序，
  // 让「先手机认领、再电脑网页认领」时后到者接管。
  function identify(ws, msg = {}) {
    const entry = entries.get(ws);
    if (!entry) return toLeaderView(electEntry());
    const rawId = typeof msg?.clientId === 'string' ? msg.clientId.trim() : '';
    if (rawId) entry.clientId = rawId;
    entry.kind = normalizeClientKind(msg?.kind);
    entry.identified = true;
    if (msg?.claim === true) {
      entry.claimed = true;
      entry.claimSeq = ++nextClaimSeq;
    } else if (msg?.claim === false) {
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

  function snapshot() {
    const current = electEntry();
    return {
      leader: toLeaderView(current),
      listeners: Array.from(entries.values(), entry => ({
        clientId: entry.clientId,
        kind: entry.kind,
        claimed: Boolean(entry.claimed),
        leader: entry === current,
      })),
    };
  }

  return {
    connect,
    identify,
    disconnect,
    leader,
    isLeader,
    canReportState,
    getClient: ws => entries.get(ws) || null,
    size: () => entries.size,
    clients: () => entries.keys(),
    snapshot,
  };
}
