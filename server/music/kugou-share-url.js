import axios from 'axios';

function extractFromQuery(urlObj) {
  const sp = urlObj.searchParams;
  const globalCollectionId = sp.get('global_collection_id') || '';
  const listid = sp.get('listid') || '';
  const uid = sp.get('uid') || '';
  const chain = sp.get('chain') || '';

  if (!globalCollectionId && !listid && !chain) return null;
  return { globalCollectionId, listid, uid, chain };
}

function extractFromPath(urlObj) {
  if (urlObj.hostname === 't1.kugou.com' || urlObj.hostname === 't.kugou.com') {
    const chain = urlObj.pathname.replace(/^\/+/, '').split('/')[0];
    if (chain) return { chain };
  }
  return null;
}

function parseUrl(raw) {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

export async function parseShareUrl(rawUrl, { axiosClient = axios } = {}) {
  if (!rawUrl || typeof rawUrl !== 'string') {
    throw new Error('parseShareUrl: 需要传入非空字符串 URL');
  }

  const urlObj = parseUrl(rawUrl.trim());
  if (!urlObj) {
    throw new Error(`parseShareUrl: 无效的 URL：${rawUrl}`);
  }

  if (!urlObj.hostname.endsWith('kugou.com')) {
    throw new Error(`parseShareUrl: 不是酷狗域名：${urlObj.hostname}`);
  }

  const fromQuery = extractFromQuery(urlObj);
  if (fromQuery && (fromQuery.globalCollectionId || fromQuery.listid)) {
    return { source: rawUrl, resolvedUrl: rawUrl, ...fromQuery };
  }

  const pathHit = extractFromPath(urlObj);
  let resolvedUrl;
  try {
    const res = await axiosClient.get(rawUrl, {
      timeout: 10_000,
      maxRedirects: 5,
      validateStatus: status => status >= 200 && status < 400,
    });
    resolvedUrl = res?.request?.res?.responseUrl || res?.config?.url || '';
  } catch (err) {
    throw new Error(`parseShareUrl: 跟随短链失败 (${err.message})`);
  }

  if (!resolvedUrl || resolvedUrl === rawUrl) {
    throw new Error(`parseShareUrl: 无法获取重定向后的最终 URL（${rawUrl}）`);
  }

  const resolvedObj = parseUrl(resolvedUrl);
  if (!resolvedObj) {
    throw new Error(`parseShareUrl: 重定向到无效 URL：${resolvedUrl}`);
  }

  const fromResolved = extractFromQuery(resolvedObj);
  if (!fromResolved || (!fromResolved.globalCollectionId && !fromResolved.listid)) {
    throw new Error(
      `parseShareUrl: 重定向后未发现 global_collection_id / listid。可能不是歌单分享链接：${resolvedUrl}`,
    );
  }

  return {
    source: rawUrl,
    resolvedUrl,
    chain: fromResolved.chain || pathHit?.chain || '',
    globalCollectionId: fromResolved.globalCollectionId,
    listid: fromResolved.listid,
    uid: fromResolved.uid,
  };
}

export default { parseShareUrl };
