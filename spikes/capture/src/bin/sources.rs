//! S5.1 probe (throwaway): what does DesktopCapturer::get_source_list() return on macOS
//! for Screen vs Window types with the SCK system picker disabled?

use libwebrtc::desktop_capturer::{
    DesktopCaptureSourceType, DesktopCapturer, DesktopCapturerOptions,
};

fn probe(kind: DesktopCaptureSourceType, label: &str) {
    let mut opts = DesktopCapturerOptions::new(kind);
    opts.set_include_cursor(false);
    opts.set_sck_system_picker(false);
    match DesktopCapturer::new(opts) {
        Some(cap) => {
            let list = cap.get_source_list();
            println!("{label}: {} source(s)", list.len());
            for s in list.iter().take(12) {
                println!(
                    "  id={} display_id={} title={:?}",
                    s.id(),
                    s.display_id(),
                    s.title()
                );
            }
        }
        None => println!("{label}: DesktopCapturer::new -> None"),
    }
}

fn main() {
    probe(DesktopCaptureSourceType::Screen, "screen");
    probe(DesktopCaptureSourceType::Window, "window");
    probe(DesktopCaptureSourceType::Generic, "generic");

    // Does window capture actually deliver frames? Pick the first listed window, pump 2 s @30.
    let mut opts = DesktopCapturerOptions::new(DesktopCaptureSourceType::Window);
    opts.set_include_cursor(false);
    opts.set_sck_system_picker(false);
    let mut cap = DesktopCapturer::new(opts).expect("window capturer");
    let Some(src) = cap.get_source_list().into_iter().next() else {
        println!("window-capture: no sources");
        return;
    };
    println!("window-capture: selecting id={} {:?}", src.id(), src.title());
    let frames = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
    let dims = std::sync::Arc::new(std::sync::Mutex::new((0, 0)));
    cap.start_capture(Some(src), {
        let frames = frames.clone();
        let dims = dims.clone();
        move |res| {
            if let Ok(f) = res {
                frames.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                *dims.lock().unwrap() = (f.width(), f.height());
            }
        }
    });
    let t0 = std::time::Instant::now();
    while t0.elapsed() < std::time::Duration::from_secs(2) {
        cap.capture_frame();
        std::thread::sleep(std::time::Duration::from_millis(33));
    }
    let n = frames.load(std::sync::atomic::Ordering::Relaxed);
    let (w, h) = *dims.lock().unwrap();
    println!("window-capture: {n} frames in 2 s, last {w}x{h}");
}
