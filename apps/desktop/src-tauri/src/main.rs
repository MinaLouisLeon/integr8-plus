// Prevents a console window appearing behind the app on Windows in release
// builds. In debug it is left on, because that is where panics are read.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    integr8_desktop_lib::run()
}
