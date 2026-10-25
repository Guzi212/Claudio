// 把已经匹配好的歌写入酷狗账号歌单。
// 只调用 KuGouMusicApi 的 user_playlist / playlist_add / playlist_tracks_add /
// playlist_tracks_del。酷狗客户端不能被远程拉起播放，这里不发任何播放指令。
import {
  fetchUserPlaylistsStrict as defaultFetchUserPlaylists,
  createUserPlaylist as defaultCreateUserPlaylist,
  addPlaylistTracks as defaultAddPlaylistTracks,
  deletePlaylistTracks as defaultDeletePlaylistTracks,
  listPlaylistFileIds as defaultListPlaylistFileIds,
} from './kugou.js';

const MAX_PAGES = 10;
const PAGE_SIZE = 100;

function trackBrief(track, reason) {
  const brief = {
    title: track.title || '',
    artist: track.artist || '',
    kugouId: track.kugouId || track.hash || '',
  };
  if (reason) brief.reason = reason;
  return brief;
}

async function findByName(name, fetchUserPlaylists) {
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const list = await fetchUserPlaylists({ page, pagesize: PAGE_SIZE });
    if (!Array.isArray(list)) throw new Error('user/playlist 返回异常');
    const found = list.find(item => String(item?.name || '').trim() === name);
    if (found) return found;
    if (list.length < PAGE_SIZE) return null;
  }
  return null;
}

async function addWithFallback(tracks, listid, addPlaylistTracks) {
  const added = [];
  const failed = [];
  if (!tracks.length) return { added, failed };
  try {
    await addPlaylistTracks({ listid, tracks });
    return { added: tracks.map(track => trackBrief(track)), failed };
  } catch (batchError) {
    if (tracks.length === 1) {
      return { added, failed: [trackBrief(tracks[0], batchError.message)] };
    }
  }

  for (const track of tracks) {
    try {
      await addPlaylistTracks({ listid, tracks: [track] });
      added.push(trackBrief(track));
    } catch (err) {
      failed.push(trackBrief(track, err.message));
    }
  }
  return { added, failed };
}

export async function writeTracksToPlaylist({
  name,
  mode = 'append',
  tracks = [],
} = {}, deps = {}) {
  const fetchUserPlaylists = deps.fetchUserPlaylists || defaultFetchUserPlaylists;
  const createUserPlaylist = deps.createUserPlaylist || defaultCreateUserPlaylist;
  const addPlaylistTracks = deps.addPlaylistTracks || defaultAddPlaylistTracks;
  const deletePlaylistTracks = deps.deletePlaylistTracks || defaultDeletePlaylistTracks;
  const listPlaylistFileIds = deps.listPlaylistFileIds || defaultListPlaylistFileIds;
  const playlistName = String(name || '').trim();
  const playlistMode = mode === 'rewrite' ? 'rewrite' : 'append';
  const songs = tracks.filter(track => track && (track.kugouId || track.hash));

  const base = {
    name: playlistName,
    mode: playlistMode,
    id: null,
    listid: null,
    globalCollectionId: '',
    created: false,
    added: [],
    failed: [],
  };

  if (!playlistName) {
    return { ...base, ok: false, error: 'playlistName 必填' };
  }
  if (!songs.length) {
    return { ...base, ok: true, skipped: true };
  }

  try {
    let created = false;
    let playlist = await findByName(playlistName, fetchUserPlaylists);
    if (!playlist) {
      playlist = await createUserPlaylist({ name: playlistName });
      created = true;
    }
    const listid = String(playlist.listid || playlist.id || '').trim();
    if (!listid) throw new Error('歌单没有 listid');

    if (playlistMode === 'rewrite' && !created) {
      const fileids = await listPlaylistFileIds({ listid });
      if (fileids.length) {
        await deletePlaylistTracks({ listid, fileids });
      }
    }

    const written = await addWithFallback(songs, listid, addPlaylistTracks);
    return {
      ...base,
      ok: written.failed.length === 0,
      id: listid,
      listid,
      globalCollectionId: playlist.globalCollectionId || '',
      created,
      added: written.added,
      failed: written.failed,
    };
  } catch (err) {
    return {
      ...base,
      ok: false,
      error: err.message,
      failed: songs.map(track => trackBrief(track, err.message)),
    };
  }
}
