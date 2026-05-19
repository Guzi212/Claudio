# 酷狗原始音乐数据

> 这里保存从酷狗截图、分享链接、复制文本整理出来的歌曲级数据。先保留原始线索，再蒸馏进 `user/taste.md`。

## 歌曲清单

| 分组 | 歌名 | 歌手 | 专辑 | 喜欢等级 | 来源 | 备注 |
| --- | --- | --- | --- | --- | --- | --- |
| 长期喜欢 | （待导入） |  |  |  |  |  |

## 原始来源

- （待补充截图、分享链接或复制文本来源）

## 使用方式

1. 把酷狗截图 OCR 文本、分享链接或复制出来的歌单粘到 `user/music/kugou_input.txt`。
2. 运行 `npm run music:import:kugou` 生成这份原始清单和 `user/music/kugou_taste_summary.md`。
3. 检查歌名/歌手没错后，运行 `node scripts/import-kugou-data.js --apply-taste` 更新 `user/taste.md`。
