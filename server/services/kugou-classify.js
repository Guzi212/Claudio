// 把待分类的歌追加到账号里已经存在的自建歌单。
// 只写 type=0 的歌单；不新建歌单，避免分类名字写错时建出垃圾歌单。
import {
  fetchUserPlaylistsStrict as defaultFetchUserPlaylists,
  fetchUserPlaylistTracks as defaultFetchUserPlaylistTracks,
  addPlaylistTracks as defaultAddPlaylistTracks,
} from './kugou.js';

const PAGE_SIZE = 100;
const MAX_PAGES = 10;

export function playlistWritable(playlist = {}) {
  return Number(playlist.type ?? 0) === 0;
}

export async function findPlaylist({ listid = '', name = '' } = {}, deps = {}) {
  const fetchUserPlaylists = deps.fetchUserPlaylists || defaultFetchUserPlaylists;
  const targetId = String(listid || '').trim();
  const targetName = String(name || '').trim();
  if (!targetId && !targetName) return null;

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const list = await fetchUserPlaylists({ page, pagesize: PAGE_SIZE });
    if (!Array.isArray(list)) throw new Error('user/playlist 返回异常');
    const found = list.find(item => {
      if (targetId) return String(item?.listid || '').trim() === targetId;
      return String(item?.name || '').trim() === targetName;
    });
    if (found) return found;
    if (list.length < PAGE_SIZE) break;
  }
  return null;
}

export async function appendTrackToPlaylist({ listid, track } = {}, deps = {}) {
  const fetchUserPlaylistTracks = deps.fetchUserPlaylistTracks || defaultFetchUserPlaylistTracks;
  const addPlaylistTracks = deps.addPlaylistTracks || defaultAddPlaylistTracks;
  const id = String(listid || '').trim();
  const hash = String(track?.kugouId || track?.hash || '').trim();
  if (!id) throw new Error('listid 必填');
  if (!hash) throw new Error('track.hash 必填');

  const { tracks } = await fetchUserPlaylistTracks({ listid: id });
  if (tracks.some(item => item.hash === hash)) {
    return { ok: true, duplicate: true, added: 0 };
  }
  await addPlaylistTracks({ listid: id, tracks: [track] });
  return { ok: true, duplicate: false, added: 1 };
}

export default { playlistWritable, findPlaylist, appendTrackToPlaylist };
