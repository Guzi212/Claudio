// 酷狗「我喜欢」歌单读写。红心 = 把歌追加到账号里的「我喜欢」歌单。
// 只调用 user/playlist、playlist/track/all/new、playlist/tracks/add、playlist/tracks/del。
import {
  fetchUserPlaylistsStrict as defaultFetchUserPlaylists,
  fetchUserPlaylistTracks as defaultFetchUserPlaylistTracks,
  addPlaylistTracks as defaultAddPlaylistTracks,
  deletePlaylistTracks as defaultDeletePlaylistTracks,
  resolveTrackMeta as defaultResolveTrackMeta,
} from './kugou.js';

const PAGE_SIZE = 100;
const MAX_PAGES = 10;
const CACHE_TTL_MS = 2 * 60 * 1000;

export function favoritePlaylistName() {
  return String(process.env.CLAUDIO_FAVORITE_PLAYLIST || '我喜欢').trim() || '我喜欢';
}

async function findPlaylist(name, fetchUserPlaylists) {
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const list = await fetchUserPlaylists({ page, pagesize: PAGE_SIZE });
    if (!Array.isArray(list)) throw new Error('user/playlist 返回异常');
    const found = list.find(item => String(item?.name || '').trim() === name);
    if (found) return found;
    if (list.length < PAGE_SIZE) return null;
  }
  return null;
}

export function createFavoriteStore(deps = {}) {
  const fetchUserPlaylists = deps.fetchUserPlaylists || defaultFetchUserPlaylists;
  const fetchUserPlaylistTracks = deps.fetchUserPlaylistTracks || defaultFetchUserPlaylistTracks;
  const addPlaylistTracks = deps.addPlaylistTracks || defaultAddPlaylistTracks;
  const deletePlaylistTracks = deps.deletePlaylistTracks || defaultDeletePlaylistTracks;
  const resolveTrackMeta = deps.resolveTrackMeta || defaultResolveTrackMeta;
  const now = deps.now || (() => Date.now());
  let cache = null;

  async function load(force = false) {
    if (!force && cache && now() - cache.loadedAt < CACHE_TTL_MS) return cache;
    const name = favoritePlaylistName();
    const playlist = await findPlaylist(name, fetchUserPlaylists);
    if (!playlist) throw new Error(`没有找到歌单「${name}」`);
    const listid = String(playlist.listid || playlist.id || '').trim();
    if (!listid) throw new Error(`歌单「${name}」没有 listid`);
    // 收藏列表必须读最新：KuGouMusicApi 会缓存 2 分钟，刚加/刚删的歌会看不到。
    const { tracks } = await fetchUserPlaylistTracks({ listid, fresh: true });
    const files = new Map();
    for (const track of tracks) {
      if (track.hash) files.set(track.hash, track.fileid || '');
    }
    cache = { name, listid, files, loadedAt: now() };
    return cache;
  }

  async function ensureMeta(track) {
    if (track.albumId && track.mixsongid) return track;
    const meta = await resolveTrackMeta({
      title: track.title,
      artist: track.artist || '',
      hash: track.kugouId || track.hash || '',
    });
    if (!meta) return track;
    return {
      ...track,
      album: track.album || meta.album || '',
      albumId: track.albumId || meta.albumId || '',
      mixsongid: track.mixsongid || meta.mixsongid || '',
      cover: track.cover || meta.cover || '',
    };
  }

  async function isFavorite(hash) {
    const key = String(hash || '').trim();
    if (!key) return false;
    const state = await load();
    return state.files.has(key);
  }

  async function add(track = {}) {
    const key = String(track.kugouId || track.hash || '').trim();
    if (!key) throw new Error('track.hash 必填');
    const state = await load();
    const playlist = { name: state.name, listid: state.listid };
    if (state.files.has(key)) {
      return { ok: true, liked: true, duplicate: true, playlist };
    }
    const full = await ensureMeta({ ...track, kugouId: key });
    await addPlaylistTracks({ listid: state.listid, tracks: [full] });
    // 新写入的 fileid 要等下次刷新才知道，先占位，取消收藏时会强制刷新。
    state.files.set(key, '');
    return { ok: true, liked: true, duplicate: false, playlist, track: full };
  }

  async function remove(track = {}) {
    const key = String(track.kugouId || track.hash || '').trim();
    if (!key) throw new Error('track.hash 必填');
    let state = await load();
    let fileid = state.files.get(key);
    if (!fileid) {
      state = await load(true);
      fileid = state.files.get(key);
    }
    const playlist = { name: state.name, listid: state.listid };
    if (!fileid) {
      return { ok: true, liked: false, removed: false, playlist };
    }
    await deletePlaylistTracks({ listid: state.listid, fileids: [fileid] });
    state.files.delete(key);
    return { ok: true, liked: false, removed: true, playlist };
  }

  return {
    load,
    isFavorite,
    add,
    remove,
    invalidate: () => { cache = null; },
  };
}

export const favoriteStore = createFavoriteStore();

export default { favoriteStore, createFavoriteStore, favoritePlaylistName };
