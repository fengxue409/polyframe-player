//! Win32 子窗口托管：在主窗口 HWND 下创建 WS_CHILD 渲染表面（mpv --wid 目标）
//!
//! 设计要点：
//!  - 子窗口在独立线程创建并跑消息泵（GetMessageW），关闭用 WM_CLOSE；
//!  - CreateWindowExW 直接传 hWndParent + WS_CHILD（无需再 SetParent）；
//!  - 坐标全部是父窗口客户区物理像素（DPI 换算由调用方完成）；
//!  - 跨线程 SetWindowPos / ShowWindow 合法（窗口仅作渲染表面，无 UI 逻辑）。

#![cfg(windows)]

use std::sync::mpsc;
use std::time::Duration;

use windows_sys::Win32::Foundation::{HWND, LPARAM, WPARAM};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DispatchMessageW, GetMessageW, PostMessageW, RegisterClassW,
    SetWindowPos, ShowWindow, TranslateMessage, MSG, SWP_NOACTIVATE, SWP_NOZORDER, SW_HIDE,
    SW_SHOW, WM_CLOSE, WNDCLASSW, WS_CHILD, WS_VISIBLE,
};

const CLASS_NAME: &[u16] = &[
    b'P' as u16, b'F' as u16, b'_' as u16, b'M' as u16, b'P' as u16, b'V' as u16,
    b'C' as u16, b'h' as u16, b'i' as u16, b'l' as u16, b'd' as u16, 0,
];

/// 启动窗口线程：创建子窗口（parent 客户区内 0×0 起步），返回子 HWND 与窗口线程句柄。
pub fn spawn_child_window(
    parent: isize,
) -> Result<(isize, std::thread::JoinHandle<()>), String> {
    let (tx, rx) = mpsc::channel::<isize>();
    let handle = std::thread::Builder::new()
        .name("pf-mpv-window".into())
        .spawn(move || unsafe {
            let hinstance = GetModuleHandleW(std::ptr::null());
            let wc = WNDCLASSW {
                style: 0,
                lpfnWndProc: Some(DefWindowProcW),
                cbClsExtra: 0,
                cbWndExtra: 0,
                hInstance: hinstance,
                hIcon: std::ptr::null_mut(),
                hCursor: std::ptr::null_mut(),
                hbrBackground: std::ptr::null_mut(),
                lpszMenuName: std::ptr::null(),
                lpszClassName: CLASS_NAME.as_ptr(),
            };
            if RegisterClassW(&wc) == 0 {
                // 已注册（重复 attach）也算成功
            }
            let hwnd = CreateWindowExW(
                0,
                CLASS_NAME.as_ptr(),
                std::ptr::null(),
                WS_CHILD | WS_VISIBLE,
                0,
                0,
                0,
                0,
                parent as HWND,
                std::ptr::null_mut(),
                hinstance,
                std::ptr::null(),
            );
            if hwnd.is_null() {
                let _ = tx.send(0);
                return;
            }
            let _ = tx.send(hwnd as isize);
            // 消息泵：收到 WM_CLOSE 由 DefWindowProcW 销毁窗口后 GetMessage 返回 0
            let mut msg: MSG = std::mem::zeroed();
            while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0 {
                TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        })
        .map_err(|e| format!("启动窗口线程失败: {e}"))?;

    let hwnd = rx
        .recv_timeout(Duration::from_secs(3))
        .map_err(|e| format!("等待子窗口创建超时: {e}"))?;
    if hwnd == 0 {
        return Err("CreateWindowExW 失败".into());
    }
    Ok((hwnd, handle))
}

/// 关闭窗口线程（发 WM_CLOSE 并等待退出）
pub fn close_child_window(hwnd: isize, handle: std::thread::JoinHandle<()>) {
    unsafe {
        PostMessageW(hwnd as HWND, WM_CLOSE, WPARAM::default(), LPARAM::default());
    }
    let _ = handle.join();
}
pub fn move_window(hwnd: isize, x: i32, y: i32, w: i32, h: i32) {
    unsafe {
        SetWindowPos(
            hwnd as HWND,
            std::ptr::null_mut(),
            x,
            y,
            w.max(1),
            h.max(1),
            SWP_NOZORDER | SWP_NOACTIVATE,
        );
    }
}

pub fn show_window(hwnd: isize, show: bool) {
    unsafe {
        ShowWindow(hwnd as HWND, if show { SW_SHOW } else { SW_HIDE });
    }
}

/// 预留：非 Windows 平台仅支持 headless（vo=null）
#[cfg(not(windows))]
pub mod stub {
    pub fn spawn_child_window(_parent: isize) -> Result<(isize, std::thread::JoinHandle<()>), String> {
        Err("非 Windows 平台不支持子窗口嵌入（headless 模式仍可用）".into())
    }
    pub fn close_child_window(_hwnd: isize, _h: std::thread::JoinHandle<()>) {}
    pub fn move_window(_hwnd: isize, _x: i32, _y: i32, _w: i32, _h: i32) {}
    pub fn show_window(_hwnd: isize, _show: bool) {}
}
