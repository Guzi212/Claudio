# ADR-0001：产品定位——给 AI Agent 用的播放器，面向普通用户

- 状态：已采纳
- 日期：2026-11-23
- 决策人：loic

## 背景

Claudio 起步时是「个人 Claude AI 电台」：Claude 读品味语料、看时间和历史，自己选歌、自己播报（`CLAUDIO_BRAIN=internal`）。
后来选歌交给外部 Grok Bot，Claudio 默认只负责检索、直链和播放（`external`），但 internal 那套选歌链路
（`claude` / `context` / `router` / `scheduler` / `tts` / `dj` / `memory` / chat / studio，约 2700 行）一直留在主干。
结果是项目名、README、实际默认行为三处说法不一致，维护成本落在一条默认不跑的路径上。

同时项目开始被身边的人使用，用户不再只有作者本人。

## 决策

1. **定位**：Claudio 是给 AI Agent 用的本地音乐播放器。Agent 负责选歌和主持，Claudio 负责找歌、出声、显示。
2. **目标用户**：普通用户——不会开终端、不会改 `.env` 的人也要能装上、用起来。
3. **internal 大脑冻结**：不再给 internal 选歌加功能；在路线图阶段 1 打存档 tag 后从主干移除。
   常驻主持人（`server/dj/resident.js`，external 下也会补歌）单独评估去留。

## 后果

- 「装得上、不掉线、出得了声」成为最高优先级；所有需要终端或 `.env` 的功能都要补界面入口。
- 对外接口（外部点歌 API、搜索、健康检查）成为公开契约，需要版本化。
- 当前 README 的「AI 一键安装」面向会用 Claude Code / Codex 的技术用户，和本决策的目标用户不一致，
  在安装器落地前作为过渡方案保留。
- 普通用户手里通常没有现成的 Agent，「Agent 从哪来」成为待定决策（见 `docs/roadmap.md` D1）。
- 打包分发给普通用户会放大非官方音源接口的合规风险（见 `docs/roadmap.md` D2）。
