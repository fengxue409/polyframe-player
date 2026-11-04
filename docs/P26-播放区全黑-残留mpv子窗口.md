# P26 播放区全黑：残留的 libmpv 子窗口

> 用户报「图2 播放区全黑」：`引擎 = hls.js`、调试面板显示 **1.5 MB/s 正在下行**、
> 侧栏进度在走（09:04 / 43:50）、有声音，但视频区是**纯 #000**，
> 连 `<video controls>` 的原生控制条、左上角弹幕角标一起消失。

## 1. 先证明「黑的不是 `<video>`」

用当前产物在 1763×1015 的真实窗口里量 DOM（`apps/desktop/out/renderer` + 真 preload）：

| 元素 | 实测 |
|---|---|
| `.video-wrap` | `x=188.3 y=85 w=1146.7 h=645`，`1.7778`（严格 16:9） |
| `.card.player` | `x=147.2 y=68 w=1228.8 h=906` |

再对用户截图做逐像素扫描（面板色 `#121722` / 页面底色 `#0b0e14` / 黑 `#000`）：

| 测量 | 图1（能播） | 图2（全黑） |
|---|---|---|
| 视频区黑/画面 x 范围 | 190 → 1335（1145） | 152 → 1298（**1146**） |
| 黑区 y 范围 | 90 → 730（16:9） | **22 → 541（503）** |
| 原生控制条 | 有 | **无** |
| 弹幕角标 | 有 | **无** |

宽度与 `.video-wrap` 完全一致（1146），高度却只有 503 —— 比例 2.28:1。
一个 `aspect-ratio: 16/9` 的盒子在任何窗口尺寸下都不可能量成 2.28:1，
所以**那不是 DOM**，而是**一块独立窗口**盖在上面，且矩形来自某次更早的布局。
它同时盖掉了原生控制条和弹幕角标 —— 这两样在图2 里正好都没了。

视频表面是 `WS_CHILD` 子窗口（P18），Windows 上唯一能盖住 renderer 又不参与布局的
就是它；P17 的弹幕覆盖层在 `engine !== 'mpv'` 时会被 `watch(overlayOn)` 收掉，
已排除。

## 2. 根因：三个洞叠在一起，窗口一旦亮起来就没人能关

```ts
// 旧代码
async mpvPushSurface(visible) {
  if (this.engine !== 'mpv' || !this.mpvReady) return   // ← 洞 1：切到 hls 后连「藏」都发不出去
  await this.rpc(MpvVisible, { visible })
}
async switchEngine(engine, video) {
  ...
  this.stop(video)      // ← 只「此刻藏一下」，不改意图
  this.engine = engine
}
async playMpv(url) {    // ← 洞 3：不校验内核，切走之后仍会 attach + loadfile
  await this.attachMpv()
  await this.mpvPushSurface(this.surfaceWanted)   // surfaceWanted 在播放页恒为 true
  await this.rpc(MpvLoad, { url })
}
```

内核侧（`pf-mpv::MpvHost`）：

```rust
pub fn stop(&self) {
    let r = self.command(&["stop"]);
    self.hide();          // ← 洞 2：只隐藏 HWND，surface_visible 仍是 true
    r
}
pub fn load(&self, url, paused) {
    let r = self.command(&["loadfile", url, "replace"]);
    if r.is_ok() && self.surface_visible() { self.show(); }   // 意图为真就 show
    r
}
```

时序（切内核时最容易踩）：

1. 在 libmpv 下播放，子窗口可见，`surface_visible = true`；
2. 点「hls.js」→ `switchEngine('hls')` → `stop()` → `mpv.stop` → `hide()`，
   但 **`surface_visible` 仍为 true** → `engine = 'hls'`；
3. 此刻还在飞的 `playMpv`（attach/loadfile 未返回）落地 → `load()` 看到意图为真 →
   **`show()` 把空黑子窗口重新亮出来**；
4. 之后 `engine` 已是 hls：`syncMpvRect` 早退不再移动它、`mpvPushSurface(false)`
   被洞 1 拦掉、`applySurface` 本来也只在 mpv 分支里推显隐 ——
   **没有任何代码再来藏它**。黑矩形就钉在最后一次同步的位置上，永久覆盖视频区。

hls 在下面照常工作（分片继续下、声音继续放、进度继续走），于是表现为
「有速度、有声音、就是全黑」。

## 3. 修复

| 位置 | 改动 |
|---|---|
| `pf-mpv/src/lib.rs` `stop()` | 先 `surface_visible = false` 再 `hide()`：停止后不存在「应当可见」，任何迟到的 `loadfile` 不会再 show |
| `stores/player.ts` `mpvPushSurface()` | **隐藏不设任何前提**（去掉 `engine`/`mpvReady` 门槛），显示仍要求 `engine === 'mpv' && mpvReady`。内核对未 attach 的 `mpv.visible` 直接回 ok，多发无副作用 |
| `stores/player.ts` `switchEngine()` | 离开 mpv 时**先显式** `mpvPushSurface(false)`（此刻 engine 还是 mpv，RPC 一定发得出去）再 `stop()` |
| `stores/player.ts` `playMpv()` | 入口与 `attachMpv` 之后各校验一次 `engine === 'mpv'`，切走即中止，不再 attach/loadfile |
| `PlayerView` `applySurface()` | `engine !== 'mpv'` 时**显式推 false**（原来是「什么都不做」） |
| `PlayerView` 巡检 | 每 3s：`engine !== 'mpv' && mpvReady` → 推一次隐藏（只在真用过 libmpv 后才跑，没装 libmpv 的机器零额外 RPC） |

外加**「有播放无画面」必须说话**：`.video-wrap` 里新增 `.stall-hint`（居中胶囊，
`pointer-events:none`，不挡原生控制条），触发条件 = `engine === 'hls' && playing`
且 `readyState < 2` 持续 ~1.5s。文案区分「清单已拿到，等待首个可解码分片」与
「画面未就绪，正在缓冲分片」。

这条提示同时是一条**现场诊断**：

- 黑区上能看见这行字 → 黑的是 `<video>`/DOM，按缓冲链路查；
- 黑区连这行字都盖住 → 上面还压着原生窗口，按本篇文章的链路查。

## 4. 验证

- `pnpm --filter @polyframe/desktop typecheck` 通过；
- `pnpm --filter @polyframe/desktop build` 通过；
- `cargo build --release --manifest-path apps/core/Cargo.toml` 通过（`pf-mpv` 改动编译 OK）；
- 真实产物复测（`.mpvcheck/`，真 renderer + 真 preload，1763×1015）：
  `.video-wrap` 仍是 `1146.7 × 645`（16:9），`.card.player` `1228.8 × 906`，布局无回归。

## 5. 注意：截图来自 10-28 的打包产物

`apps/desktop/release/` 里最近一次打包是 **10-28 21:08**，其 asar 内的 CSS 是
P24/P25 之前的版本：

```css
.video-wrap { aspect-ratio: 16/9; width: 100% }
.card.player { max-width: calc((100vh - 260px) * 16 / 9 + 34px); margin-inline: auto }
```

所以截图里的「卡片居中、两侧留白」来自这条旧的 `max-width` 规则，
不是 P25 的 `--pf-card-chrome / --pf-card-room` 预算。本次修复（含 P24/P25 的布局改动）
都只在源码里，要看效果需要跑源码或重新打包。
