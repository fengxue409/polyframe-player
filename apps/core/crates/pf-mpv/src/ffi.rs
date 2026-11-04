//! libmpv 动态 FFI 绑定（libloading 加载 libmpv-2.dll，运行时解析符号）
//!
//! 常量与结构布局对齐 vendor/mpv/include/mpv/client.h（API 2.6）：
//!  - mpv_event { event_id: c_int, error: c_int, reply_userdata: u64, data: *mut c_void }
//!  - mpv_event_property { name, format, data }
//!  - mpv_event_end_file { reason, error, ... }
//!  - 错误码为负值（MPV_ERROR_SUCCESS = 0）

#![allow(non_snake_case, dead_code)]

use std::os::raw::{c_char, c_int, c_ulong, c_void};

// ---------- mpv_format ----------
pub const MPV_FORMAT_NONE: c_int = 0;
pub const MPV_FORMAT_STRING: c_int = 1;
pub const MPV_FORMAT_FLAG: c_int = 3;
pub const MPV_FORMAT_INT64: c_int = 4;
pub const MPV_FORMAT_DOUBLE: c_int = 5;

// ---------- mpv_event_id ----------
pub const MPV_EVENT_NONE: c_int = 0;
pub const MPV_EVENT_SHUTDOWN: c_int = 1;
pub const MPV_EVENT_LOG_MESSAGE: c_int = 2;
pub const MPV_EVENT_START_FILE: c_int = 6;
pub const MPV_EVENT_END_FILE: c_int = 7;
pub const MPV_EVENT_FILE_LOADED: c_int = 8;
pub const MPV_EVENT_SEEK: c_int = 20;
pub const MPV_EVENT_PLAYBACK_RESTART: c_int = 21;
pub const MPV_EVENT_PROPERTY_CHANGE: c_int = 22;
pub const MPV_EVENT_QUEUE_OVERFLOW: c_int = 24;

// ---------- mpv_end_file_reason ----------
pub const MPV_END_FILE_REASON_EOF: c_int = 0;
pub const MPV_END_FILE_REASON_STOP: c_int = 2;
pub const MPV_END_FILE_REASON_QUIT: c_int = 3;
pub const MPV_END_FILE_REASON_ERROR: c_int = 4;

// ---------- 错误码（负值，client.h §enum mpv_error） ----------
pub fn error_name(code: c_int) -> &'static str {
    match code {
        -1 => "event queue full",
        -2 => "memory allocation failed",
        -3 => "core not uninitialized",
        -4 => "invalid parameter",
        -5 => "option not found",
        -6 => "unsupported option format",
        -7 => "error setting option",
        -8 => "property not found",
        -9 => "unsupported property format",
        -10 => "property unavailable",
        -11 => "property error",
        -12 => "error running command",
        -13 => "loading failed",
        -14 => "audio output init failed",
        -15 => "video output init failed",
        -16 => "nothing to play",
        -17 => "unknown format",
        -18 => "unsupported",
        -19 => "not implemented",
        -20 => "generic error",
        0 => "success",
        _ => "unknown error",
    }
}

// ---------- ABI 结构（repr(C)，对齐 client.h） ----------

#[repr(C)]
pub struct MpvEvent {
    pub event_id: c_int,
    pub error: c_int,
    pub reply_userdata: u64,
    pub data: *mut c_void,
}

#[repr(C)]
pub struct MpvEventProperty {
    pub name: *const c_char,
    pub format: c_int,
    pub data: *mut c_void,
}

#[repr(C)]
pub struct MpvEventLogMessage {
    pub prefix: *const c_char,
    pub level: *const c_char,
    pub text: *const c_char,
}

#[repr(C)]
pub struct MpvEventEndFile {
    pub reason: c_int,
    pub error: c_int,
    pub reason_ext: i64,
    pub playlist_entry_id: i64,
    pub playlist_insert_id: i64,
    pub playlist_insert_num_entries: c_int,
    pub unused: [c_int; 9],
}

// ---------- 函数指针表（运行时经 GetProcAddress 解析） ----------

pub struct MpvApi {
    pub lib: libloading::Library,
    pub client_api_version: unsafe extern "C" fn() -> c_ulong,
    pub create: unsafe extern "C" fn() -> *mut c_void,
    pub initialize: unsafe extern "C" fn(*mut c_void) -> c_int,
    pub terminate_destroy: unsafe extern "C" fn(*mut c_void),
    pub set_option_string: unsafe extern "C" fn(*mut c_void, *const c_char, *const c_char) -> c_int,
    pub set_property_string: unsafe extern "C" fn(*mut c_void, *const c_char, *const c_char) -> c_int,
    pub get_property_string: unsafe extern "C" fn(*mut c_void, *const c_char) -> *mut c_char,
    /// P4：通用 get_property（format 参数化，DOUBLE 取数值属性）
    pub get_property: unsafe extern "C" fn(*mut c_void, *const c_char, c_int, *mut c_void) -> c_int,
    pub free: unsafe extern "C" fn(*mut c_void),
    pub command: unsafe extern "C" fn(*mut c_void, *mut *const c_char) -> c_int,
    pub observe_property: unsafe extern "C" fn(*mut c_void, u64, *const c_char, c_int) -> c_int,
    pub request_log_messages: unsafe extern "C" fn(*mut c_void, *const c_char) -> c_int,
    pub wait_event: unsafe extern "C" fn(*mut c_void, f64) -> *mut MpvEvent,
    pub wakeup: unsafe extern "C" fn(*mut c_void),
}

// 函数指针 + Library（HMODULE）均为可跨线程传递；mpv 句柄本身不在此结构中。
// Sync：所有方法只做 FFI 调用（wait_event 的独占性由 pf-mpv 事件线程保证）
unsafe impl Send for MpvApi {}
unsafe impl Sync for MpvApi {}

/// 从已加载的动态库解析全部所需符号；任一缺失即失败（DLL 版本不兼容）
pub fn resolve(lib: libloading::Library) -> Result<MpvApi, String> {
    let get = |lib: &libloading::Library, name: &str| -> Result<*mut c_void, String> {
        unsafe {
            lib.get::<unsafe extern "C" fn()>(name.as_bytes())
                .map(|f| *f as *mut c_void)
                .map_err(|e| format!("符号 {name} 缺失（DLL 版本不兼容）: {e}"))
        }
    };
    let mut ptrs: Vec<(&'static str, *mut c_void)> = Vec::new();
    let names = [
        "mpv_client_api_version",
        "mpv_create",
        "mpv_initialize",
        "mpv_terminate_destroy",
        "mpv_set_option_string",
        "mpv_set_property_string",
        "mpv_get_property_string",
        "mpv_get_property",
        "mpv_free",
        "mpv_command",
        "mpv_observe_property",
        "mpv_request_log_messages",
        "mpv_wait_event",
        "mpv_wakeup",
    ];
    for n in names {
        ptrs.push((n, get(&lib, n)?));
    }
    // 将原始指针逐个转型为函数指针（类型安全检查由调用签名约定保证）
    macro_rules! fnptr {
        ($n:expr, $t:ty) => {
            unsafe { std::mem::transmute::<*mut c_void, $t>(ptrs.iter().find(|(n, _)| *n == $n).unwrap().1) }
        };
    }
    Ok(MpvApi {
        lib,
        client_api_version: fnptr!("mpv_client_api_version", unsafe extern "C" fn() -> c_ulong),
        create: fnptr!("mpv_create", unsafe extern "C" fn() -> *mut c_void),
        initialize: fnptr!("mpv_initialize", unsafe extern "C" fn(*mut c_void) -> c_int),
        terminate_destroy: fnptr!("mpv_terminate_destroy", unsafe extern "C" fn(*mut c_void)),
        set_option_string: fnptr!(
            "mpv_set_option_string",
            unsafe extern "C" fn(*mut c_void, *const c_char, *const c_char) -> c_int
        ),
        set_property_string: fnptr!(
            "mpv_set_property_string",
            unsafe extern "C" fn(*mut c_void, *const c_char, *const c_char) -> c_int
        ),
        get_property_string: fnptr!(
            "mpv_get_property_string",
            unsafe extern "C" fn(*mut c_void, *const c_char) -> *mut c_char
        ),
        get_property: fnptr!(
            "mpv_get_property",
            unsafe extern "C" fn(*mut c_void, *const c_char, c_int, *mut c_void) -> c_int
        ),
        free: fnptr!("mpv_free", unsafe extern "C" fn(*mut c_void)),
        command: fnptr!("mpv_command", unsafe extern "C" fn(*mut c_void, *mut *const c_char) -> c_int),
        observe_property: fnptr!(
            "mpv_observe_property",
            unsafe extern "C" fn(*mut c_void, u64, *const c_char, c_int) -> c_int
        ),
        request_log_messages: fnptr!(
            "mpv_request_log_messages",
            unsafe extern "C" fn(*mut c_void, *const c_char) -> c_int
        ),
        wait_event: fnptr!("mpv_wait_event", unsafe extern "C" fn(*mut c_void, f64) -> *mut MpvEvent),
        wakeup: fnptr!("mpv_wakeup", unsafe extern "C" fn(*mut c_void)),
    })
}
