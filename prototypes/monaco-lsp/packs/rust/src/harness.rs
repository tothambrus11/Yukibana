//! The test runner the Rust pack's runner.js gives a test build in place of
//! libtest's own (`-Zcrate-attr=test_runner(yukibana_test::run)`), because
//! of the one thing Miri cannot do here: unwind. The standard library this
//! Miri interprets was built for Linux, not for Miri, so a panic ends in
//! `_Unwind_RaiseException`, which Miri does not implement, and the whole
//! program stops. libtest would lose the panicking test's report with it.
//!
//! So this runner runs the tests libtest would run, one at a time and in
//! libtest's order, and tells runner.js what happens on control lines
//! (stdout, starting with U+001E) that runner.js turns into libtest's own
//! report. When a test panics, the panic hook sends the message and the
//! test's captured output before the program dies; runner.js then starts
//! the program again, with the tests already reported in YUKIBANA_DONE
//! (the environment, because this std cannot read its arguments either).
//!
//! Each control line is `\x1e<kind> <fields separated by \x1f>\n`, with `\`,
//! newlines and the two separators escaped as `\\`, `\n`, `\x1e`, `\x1f`.

#![feature(test, internal_output_capture)]

extern crate test;

use std::io::Write;
use std::sync::{Arc, Mutex};
use test::{ShouldPanic, TestDescAndFn, TestFn};

static CURRENT: Mutex<String> = Mutex::new(String::new());
static CAPTURE: Mutex<Option<Arc<Mutex<Vec<u8>>>>> = Mutex::new(None);

fn escape(field: &str) -> String {
    let mut out = String::with_capacity(field.len());
    for c in field.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\u{1e}' => out.push_str("\\x1e"),
            '\u{1f}' => out.push_str("\\x1f"),
            c => out.push(c),
        }
    }
    out
}

/// One control line, straight to stdout (not through the capture).
fn control(kind: &str, fields: &[&str]) {
    let line = fields.iter().map(|f| escape(f)).collect::<Vec<_>>().join("\u{1f}");
    let mut out = std::io::stdout().lock();
    let _ = write!(out, "\u{1e}{kind} {line}\n");
    let _ = out.flush();
}

/// What the test printed so far, ending the capture.
fn captured() -> String {
    std::io::set_output_capture(None);
    match CAPTURE.lock().unwrap().take() {
        Some(sink) => String::from_utf8_lossy(&sink.lock().unwrap()).into_owned(),
        None => String::new(),
    }
}

/// The custom test framework's entry: every `#[test]` of the crate.
pub fn run(tests: &[&TestDescAndFn]) {
    let done: Vec<String> = std::env::var("YUKIBANA_DONE")
        .map(|s| s.split('\n').filter(|n| !n.is_empty()).map(String::from).collect())
        .unwrap_or_default();
    let mut tests: Vec<&TestDescAndFn> = tests.to_vec();
    tests.sort_by(|a, b| a.desc.name.as_slice().cmp(b.desc.name.as_slice()));
    control("count", &[&tests.len().to_string()]);

    std::panic::set_hook(Box::new(|info| {
        let output = captured();
        let message = if let Some(s) = info.payload().downcast_ref::<&str>() {
            s.to_string()
        } else if let Some(s) = info.payload().downcast_ref::<String>() {
            s.clone()
        } else {
            "Box<dyn Any>".to_string()
        };
        let location = info.location().map(|l| l.to_string()).unwrap_or_default();
        let name = CURRENT.lock().map(|n| n.clone()).unwrap_or_default();
        control("panic", &[&name, &output, &location, &message]);
    }));

    for t in tests {
        let name = t.desc.name.as_slice();
        if done.iter().any(|d| d == name) {
            continue;
        }
        let f = match t.testfn {
            TestFn::StaticTestFn(f) => f,
            // Benchmarks need #![feature(test)] in the crate and a Bencher;
            // they are left out, as `cargo test` without --benches would.
            _ => continue,
        };
        if t.desc.ignore {
            control("ignored", &[name, t.desc.ignore_message.unwrap_or("")]);
            continue;
        }
        let expected = match t.desc.should_panic {
            ShouldPanic::No => None,
            ShouldPanic::Yes => Some(""),
            ShouldPanic::YesWithMessage(m) => Some(m),
        };
        *CURRENT.lock().unwrap() = name.to_string();
        match expected {
            None => control("start", &[name]),
            Some(m) => control("start", &[name, m]),
        }
        let sink = Arc::new(Mutex::new(Vec::new()));
        *CAPTURE.lock().unwrap() = Some(sink.clone());
        std::io::set_output_capture(Some(sink));
        let result = f();
        let output = captured();
        match (result, expected) {
            (Ok(()), None) => control("ok", &[name]),
            (Ok(()), Some(_)) => control("fail", &[name, &output, "note: test did not panic as expected"]),
            (Err(message), _) => control("fail", &[name, &output, &message]),
        }
    }
    control("end", &[]);
}
