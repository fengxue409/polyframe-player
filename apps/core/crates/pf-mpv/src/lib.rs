//! pf-mpv：libmpv 托管（DESIGN §4.4）
//!
//! 技术路线（P3 定案）：
//!  - libloading 动态加载 libmpv-2.dll（DLL 缺失 → Err，上层优雅降级 hls.js）
//!  - Windows：Rust 侧创建 WS_CHILD 子窗口挂主窗口 HWND（CreateWindowExW hWndParent），
//!    mpv 以 `wid=子HWND + vo=gpu-next + hwdec=auto-safe` 渲染；
//!  - parent=0 → headless（vo=null + ao=null），供无头冒烟验证 DLL/FFI/解复用管线；
//!  - 事件线程独占 mpv_wait_event；属性变化写入共享快照（版本号驱动），
//!    pf-core 250ms 泵推送 `mpv.state` 通知。

pub mod ffi;
#[cfg(windows)]
pub mod window;

use std::ffi::CString;
use std::os::raw::{c_char, c_int, c_void};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;

use crate::ffi::MPV_FORMAT_DOUBLE;

// ---------- 状态模型（与 packages/shared 的 MpvState 同构，camelCase） ----------

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MpvState {
    /// 已加载媒体且解码推进中
    pub playing: bool,
    pub pause: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub time_pos: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub media_title: Option<String>,
    pub eof: bool,
    pub alive: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
}

/// mpv 轨道（track-list 归并，与 packages/shared 的 MpvTrack 同构）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MpvTrack {
    pub id: u64,
    /// "audio" | "video" | "sub"
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lang: Option<String>,
    #[serde(skip_serializing_if = "std::option::Option::is_none")]
    pub default: Option<bool>,
    pub selected: bool,
}

// ---------- DLL 发现 ----------

/// DLL 搜索路径：PF_MPV_DLL（显式文件）> exe 同目录 > exe/mpv/ > 仓库 vendor（dev）
pub fn discover_dll() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("PF_MPV_DLL") {
        let p = PathBuf::from(p);
        if p.is_file() {
            return Some(p);
        }
    }
    let exe = std::env::current_exe().ok()?;
    let exe_dir = exe.parent()?;
    let candidates = [
        exe_dir.join("libmpv-2.dll"),
        exe_dir.join("mpv").join("libmpv-2.dll"),
        // dev：target/{debug,release}/pf-core.exe → apps/core/vendor/mpv/
        exe_dir.join("../../vendor/mpv/libmpv-2.dll"),
    ];
    candidates.into_iter().find(|p| p.is_file())
}

/// 探测（不加载实例）：DLL 是否可用
pub fn probe() -> Option<PathBuf> {
    discover_dll()
}

// ---------- 托管实现 ----------

struct Shared {
    state: Mutex<MpvState>,
    version: AtomicU64,
}

struct Inner {
    h: *mut c_void,
    api: Arc<ffi::MpvApi>,
    shared: Arc<Shared>,
    child_hwnd: Option<isize>,
    #[cfg(windows)]
    window_thread: Option<std::thread::JoinHandle<()>>,
    event_thread: Option<std::thread::JoinHandle<()>>,
    stop_flag: Arc<AtomicBool>,
    dead: AtomicBool,
    /// 视频表面「应当可见」的用户意图（切页隐藏 = false）。只影响窗口显隐，与播放状态无关。
    surface_visible: AtomicBool,
}

unsafe impl Send for Inner {}
unsafe impl Sync for Inner {}

impl Drop for Inner {
    fn drop(&mut self) {
        if self.dead.swap(true, Ordering::SeqCst) {
            return;
        }
        self.stop_flag.store(true, Ordering::SeqCst);
        unsafe { (self.api.wakeup)(self.h) };
        if let Some(t) = self.event_thread.take() {
            let _ = t.join();
        }
        unsafe { (self.api.terminate_destroy)(self.h) };
        #[cfg(windows)]
        if let (Some(hwnd), Some(t)) = (self.child_hwnd, self.window_thread.take()) {
            window::close_child_window(hwnd, t);
        }
    }
}

/// mpv 实例裸句柄的 Send 包装（mpv 客户端句柄线程安全性由 mpv 保证：除 wait_event 外可跨线程调用）
#[derive(Clone, Copy)]
struct RawHandle(*mut c_void);
unsafe impl Send for RawHandle {}

/// libmpv 托管句柄（Arc 共享；Drop 安全回收）
#[derive(Clone)]
pub struct MpvHost {
    inner: Arc<Inner>,
}

fn cstr(s: &str) -> Result<CString, String> {
    CString::new(s).map_err(|_| format!("非法 C 字符串: {s:?}"))
}

impl MpvHost {
    /// parent：主窗口 HWND（0 = headless，vo/ao=null）
    pub fn attach(parent: isize) -> Result<MpvHost, String> {
        let dll = discover_dll().ok_or_else(|| {
            "未找到 libmpv-2.dll（检查 apps/core/vendor/mpv/ 或 PF_MPV_DLL 环境变量）".to_string()
        })?;
        Self::attach_with(parent, &dll)
    }

    pub fn attach_with(parent: isize, dll: &Path) -> Result<MpvHost, String> {
        // 1. 加载 DLL（DLL_LOAD_DIR 让同目录依赖可解析）+ 解析符号
        #[cfg(windows)]
        let lib = unsafe {
            use libloading::os::windows::*;
            Library::load_with_flags(
                dll,
                LOAD_LIBRARY_SEARCH_DEFAULT_DIRS | LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR,
            )
        }
        .map_err(|e| format!("加载 {} 失败: {e}", dll.display()))?;
        #[cfg(not(windows))]
        let lib = libloading::Library::new(dll).map_err(|e| format!("加载失败: {e}"))?;
        let api = ffi::resolve(lib.into())?;

        // 2. API 版本校验（要求 2.x）
        let ver = unsafe { (api.client_api_version)() };
        if u64::from(ver) < ((2 << 16) as u64) {
            return Err(format!("libmpv API 版本过低: {ver:#x}"));
        }

        // 3. 子窗口（windowed 模式）
        #[cfg(windows)]
        let (child, wthread) = if parent != 0 {
            let (hwnd, t) = window::spawn_child_window(parent)?;
            (Some(hwnd), Some(t))
        } else {
            (None, None)
        };
        #[cfg(not(windows))]
        let (child, wthread) = (None, None);

        // 4. 创建 mpv 实例 + 选项
        let h = unsafe { (api.create)() };
        if h.is_null() {
            return Err("mpv_create 失败".into());
        }
        let api = Arc::new(api);
        let set_opt = |name: &str, value: &str| -> Result<(), String> {
            let n = cstr(name)?;
            let v = cstr(value)?;
            let r = unsafe { (api.set_option_string)(h, n.as_ptr(), v.as_ptr()) };
            if r < 0 {
                return Err(format!("设置 {name}={value} 失败: {}", ffi::error_name(r)));
            }
            Ok(())
        };
        if let Some(hwnd) = child {
            set_opt("wid", &hwnd.to_string())?;
            set_opt("vo", "gpu-next")?;
            set_opt("hwdec", "auto-safe")?;
        } else {
            // headless（冒烟）：纯解复用/解码管线
            set_opt("vo", "null")?;
            set_opt("ao", "null")?;
        }
        set_opt("demuxer-max-bytes", "256MiB")?;
        set_opt("demuxer-readahead-secs", "8")?;
        set_opt("cache-pause-wait", "2")?;
        set_opt("keep-open", "always")?;
        set_opt("ytdl", "no")?; // 关闭 youtube-dl 兜底（纯 HLS/MP4 场景，避免子进程噪音）
        set_opt("osc", "no")?;
        set_opt("input-default-bindings", "no")?;
        set_opt("input-vo-keyboard", "no")?;
        set_opt("input-cursor", "no")?;
        set_opt("force-window", "no")?;

        let r = unsafe { (api.initialize)(h) };
        if r < 0 {
            unsafe { (api.terminate_destroy)(h) };
            return Err(format!("mpv_initialize 失败: {}", ffi::error_name(r)));
        }

        // 5. 日志（warn 级以上转发 stderr）+ 属性观察
        if let Ok(lv) = cstr("warn") {
            unsafe { (api.request_log_messages)(h, lv.as_ptr()) };
        }
        for (name, fmt) in [
            ("time-pos", ffi::MPV_FORMAT_DOUBLE),
            ("duration", ffi::MPV_FORMAT_DOUBLE),
            ("pause", ffi::MPV_FORMAT_FLAG),
            ("eof-reached", ffi::MPV_FORMAT_FLAG),
            ("media-title", ffi::MPV_FORMAT_STRING),
        ] {
            if let Ok(n) = cstr(name) {
                unsafe { (api.observe_property)(h, 0, n.as_ptr(), fmt) };
            }
        }

        // 6. 事件线程（独占 wait_event）
        let shared = Arc::new(Shared {
            state: Mutex::new(MpvState {
                alive: true,
                ..Default::default()
            }),
            version: AtomicU64::new(1),
        });
        let stop_flag = Arc::new(AtomicBool::new(false));
        let ev_thread = {
            let shared = shared.clone();
            let stop_flag = stop_flag.clone();
            let handle = RawHandle(h);
            let api = Arc::clone(&api);
            std::thread::Builder::new()
                .name("pf-mpv-events".into())
                .spawn(move || unsafe {
                    event_loop(handle, &api, &shared, &stop_flag);
                })
                .map_err(|e| format!("启动事件线程失败: {e}"))?
        };

        Ok(MpvHost {
            inner: Arc::new(Inner {
                h,
                api,
                shared,
                child_hwnd: child,
                #[cfg(windows)]
                window_thread: wthread,
                event_thread: Some(ev_thread),
                stop_flag,
                dead: AtomicBool::new(false),
                surface_visible: AtomicBool::new(true),
            }),
        })
    }

    // ---- 状态 ----

    pub fn state(&self) -> MpvState {
        self.inner.shared.state.lock().unwrap().clone()
    }

    pub fn state_version(&self) -> u64 {
        self.inner.shared.version.load(Ordering::SeqCst)
    }

    pub fn is_alive(&self) -> bool {
        !self.inner.dead.load(Ordering::SeqCst) && self.inner.shared.state.lock().unwrap().alive
    }

    // ---- 窗口 ----

    pub fn move_window(&self, x: i32, y: i32, w: i32, h: i32) {
        #[cfg(windows)]
        if let Some(hwnd) = self.inner.child_hwnd {
            window::move_window(hwnd, x, y, w, h);
        }
    }

    /// 裸显隐（不改用户意图）：仅用于临时遮挡，如 stop 后收起画面。
    pub fn show(&self) {
        #[cfg(windows)]
        if let Some(hwnd) = self.inner.child_hwnd {
            window::show_window(hwnd, true);
        }
    }

    pub fn hide(&self) {
        #[cfg(windows)]
        if let Some(hwnd) = self.inner.child_hwnd {
            window::show_window(hwnd, false);
        }
    }

    /// 设置「视频表面应当可见」并立即生效。
    ///
    /// 切到别的页面时传 false：子窗口是 WS_CHILD，只服 Win32 显隐，不吃 DOM 的
    /// `display:none` —— 不显式藏起来就会一直盖在别的页面上。**播放不受影响**，
    /// 只是不画到屏幕上（音频继续）。
    pub fn set_surface_visible(&self, visible: bool) {
        self.inner.surface_visible.store(visible, Ordering::SeqCst);
        if visible {
            self.show();
        } else {
            self.hide();
        }
    }

    pub fn surface_visible(&self) -> bool {
        self.inner.surface_visible.load(Ordering::SeqCst)
    }

    // ---- 播放控制 ----

    /// 载入媒体。窗口显隐跟随 `surface_visible`：在别的页面上自动连播下一集时，
    /// loadfile 不能把视频窗口重新弹出来盖住当前页面。
    pub fn load(&self, url: &str, paused: bool) -> Result<(), String> {
        self.set_property("pause", if paused { "yes" } else { "no" })?;
        let r = self.command(&["loadfile", url, "replace"]);
        if r.is_ok() && self.surface_visible() {
            self.show();
        }
        r
    }

    pub fn stop(&self) -> Result<(), String> {
        let r = self.command(&["stop"]);
        // 停止后不可能还有画面：把「应当可见」的意图一起清掉，再藏窗口。
        //
        // 只 hide() 不改意图会留下一个致命的坑：`load()` 里是「意图为真就 show()」，
        // 所以只要还有一次 loadfile 在路上（切内核的瞬间 `playMpv` 往往正卡在
        // attach/loadfile 上），它落地时就会把这块**空黑子窗口**重新 show 出来。
        // 此时 renderer 的 engine 早已是 hls，`mpvPushSurface(false)` 会因为
        // `engine !== 'mpv'` 直接 return、`syncMpvRect` 也早退 —— 没人再能藏它，
        // 于是视频区被一块永不消失的黑矩形盖住：hls 在下面照常下数据、有声音，
        // 画面上却什么都看不到（原生控制条、弹幕角标一起被盖掉）。
        self.inner.surface_visible.store(false, Ordering::SeqCst);
        self.hide();
        r
    }

    pub fn seek(&self, seconds: f64, absolute: bool) -> Result<(), String> {
        let mode = if absolute { "absolute" } else { "relative" };
        self.command(&["seek", &format!("{seconds:.3}"), mode])
    }

    pub fn set_property(&self, name: &str, value: &str) -> Result<(), String> {
        let n = cstr(name)?;
        let v = cstr(value)?;
        let r = unsafe { (self.inner.api.set_property_string)(self.inner.h, n.as_ptr(), v.as_ptr()) };
        if r < 0 {
            return Err(format!("设置 {name}={value} 失败: {}", ffi::error_name(r)));
        }
        Ok(())
    }

    /// 读属性（P4：DOUBLE 强类型优先——time-pos/duration 等数值属性返回数字字符串
    /// 与旧版一致，但来源是 mpv 原生 double，避免字符串精度损失；非数值属性回退 string）
    pub fn get_property(&self, name: &str) -> Option<String> {
        let n = cstr(name).ok()?;
        unsafe {
            let mut d: f64 = 0.0;
            let rc = (self.inner.api.get_property)(
                self.inner.h,
                n.as_ptr(),
                MPV_FORMAT_DOUBLE,
                &mut d as *mut f64 as *mut c_void,
            );
            if rc == 0 {
                return Some(format!("{d}"));
            }
            let p = (self.inner.api.get_property_string)(self.inner.h, n.as_ptr());
            if p.is_null() {
                return None;
            }
            let s = std::ffi::CStr::from_ptr(p).to_string_lossy().into_owned();
            (self.inner.api.free)(p as *mut c_void);
            Some(s)
        }
    }

    /// track-list 归并（get_property_string 对复合属性返回 JSON 文本）
    pub fn tracklist(&self) -> Vec<MpvTrack> {
        let Some(raw) = self.get_property("track-list") else {
            return Vec::new();
        };
        #[derive(serde::Deserialize)]
        struct RawTrack {
            id: u64,
            #[serde(rename = "type")]
            kind: String,
            title: Option<String>,
            lang: Option<String>,
            default: Option<bool>,
            selected: Option<bool>,
        }
        serde_json::from_str::<Vec<RawTrack>>(&raw)
            .map(|v| {
                v.into_iter()
                    .map(|t| MpvTrack {
                        id: t.id,
                        kind: t.kind,
                        title: t.title,
                        lang: t.lang,
                        default: t.default,
                        selected: t.selected.unwrap_or(false),
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    pub fn command(&self, args: &[&str]) -> Result<(), String> {
        let mut c_args: Vec<CString> = Vec::with_capacity(args.len() + 1);
        for a in args {
            c_args.push(cstr(a)?);
        }
        // mpv_command 要求 NULL 指针终止（非空字符串）
        let mut ptrs: Vec<*const c_char> = c_args.iter().map(|c| c.as_ptr()).collect();
        ptrs.push(std::ptr::null());
        let r = unsafe { (self.inner.api.command)(self.inner.h, ptrs.as_mut_ptr()) };
        if r < 0 {
            return Err(format!("命令 {:?} 失败: {}", args, ffi::error_name(r)));
        }
        Ok(())
    }
}

/// 事件循环：唯一允许调用 wait_event 的线程
unsafe fn event_loop(
    h: RawHandle,
    api: &Arc<ffi::MpvApi>,
    shared: &Arc<Shared>,
    stop_flag: &AtomicBool,
) {
    let h = h.0;
    loop {
        if stop_flag.load(Ordering::SeqCst) {
            break;
        }
        let ev = (api.wait_event)(h, 0.5);
        if ev.is_null() {
            continue; // 超时
        }
        match (*ev).event_id {
            ffi::MPV_EVENT_NONE => {}
            ffi::MPV_EVENT_SHUTDOWN => {
                let mut st = shared.state.lock().unwrap();
                st.alive = false;
                shared.version.fetch_add(1, Ordering::SeqCst);
                break;
            }
            ffi::MPV_EVENT_LOG_MESSAGE => {
                let data = (*ev).data as *mut ffi::MpvEventLogMessage;
                if !data.is_null() {
                    let prefix = std::ffi::CStr::from_ptr((*data).prefix).to_string_lossy();
                    let text = std::ffi::CStr::from_ptr((*data).text).to_string_lossy();
                    let text = text.trim_end();
                    if !text.is_empty() {
                        eprintln!("[mpv/{prefix}] {text}");
                    }
                }
            }
            ffi::MPV_EVENT_END_FILE => {
                let data = (*ev).data as *mut ffi::MpvEventEndFile;
                let (reason, err) = if data.is_null() {
                    (ffi::MPV_END_FILE_REASON_STOP, 0)
                } else {
                    ((*data).reason, (*data).error)
                };
                let mut st = shared.state.lock().unwrap();
                st.playing = false;
                st.time_pos = None;
                if reason == ffi::MPV_END_FILE_REASON_EOF {
                    st.eof = true;
                } else if reason == ffi::MPV_END_FILE_REASON_ERROR && err < 0 {
                    st.last_error = Some(ffi::error_name(err).to_string());
                }
                shared.version.fetch_add(1, Ordering::SeqCst);
            }
            ffi::MPV_EVENT_FILE_LOADED | ffi::MPV_EVENT_PLAYBACK_RESTART => {
                let mut st = shared.state.lock().unwrap();
                st.playing = true;
                st.eof = false;
                st.last_error = None;
                shared.version.fetch_add(1, Ordering::SeqCst);
            }
            ffi::MPV_EVENT_PROPERTY_CHANGE => {
                let data = (*ev).data as *mut ffi::MpvEventProperty;
                if data.is_null() {
                    continue;
                }
                let name = std::ffi::CStr::from_ptr((*data).name).to_string_lossy().into_owned();
                let mut st = shared.state.lock().unwrap();
                match name.as_str() {
                    "time-pos" => {
                        st.time_pos = prop_double(&*data);
                    }
                    "duration" => {
                        st.duration = prop_double(&*data);
                    }
                    "pause" => {
                        st.pause = prop_flag(&*data).unwrap_or(false);
                    }
                    "eof-reached" => {
                        st.eof = prop_flag(&*data).unwrap_or(false);
                    }
                    "media-title" => {
                        st.media_title = prop_string(&*data);
                    }
                    _ => {}
                }
                shared.version.fetch_add(1, Ordering::SeqCst);
            }
            _ => {}
        }
    }
}

unsafe fn prop_double(p: &ffi::MpvEventProperty) -> Option<f64> {
    if p.format != ffi::MPV_FORMAT_DOUBLE || p.data.is_null() {
        return None;
    }
    Some(*(p.data as *const f64))
}

unsafe fn prop_flag(p: &ffi::MpvEventProperty) -> Option<bool> {
    if p.format != ffi::MPV_FORMAT_FLAG || p.data.is_null() {
        return None;
    }
    Some(*(p.data as *const c_int) != 0)
}

unsafe fn prop_string(p: &ffi::MpvEventProperty) -> Option<String> {
    if p.format != ffi::MPV_FORMAT_STRING || p.data.is_null() {
        return None;
    }
    let s = *(p.data as *const *const c_char);
    if s.is_null() {
        return None;
    }
    Some(std::ffi::CStr::from_ptr(s).to_string_lossy().into_owned())
}
