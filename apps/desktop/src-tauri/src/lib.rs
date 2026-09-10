//! The Tauri shell.
//!
//! Almost nothing happens here, and that is deliberate: the interface is one
//! bundle that also runs as a browser page, and P05's second exit criterion is
//! that the two behave identically. Anything implemented here rather than in
//! TypeScript is behaviour the browser build cannot have.
//!
//! What is here is the one thing a browser genuinely cannot do — put a refresh
//! token somewhere the operating system protects.

use keyring::Entry;

/// Where the credential is filed in the OS store.
///
/// The service name is what appears in Keychain Access or the Windows
/// Credential Manager, so it is the product name rather than a bundle
/// identifier: somebody auditing their own machine should recognise it.
const SERVICE: &str = "Integr8 Plus";
const ACCOUNT: &str = "session";

/// Turns a keyring failure into something the front end can show.
///
/// The message is deliberately vague about *why*. A Linux desktop with no
/// Secret Service running, a locked keychain and a denied prompt are all "we
/// could not reach the credential store", and the difference matters to a
/// support conversation rather than to the person looking at the screen.
fn describe(error: keyring::Error) -> String {
    format!("Could not reach the system credential store: {error}")
}

fn entry() -> Result<Entry, String> {
    Entry::new(SERVICE, ACCOUNT).map_err(describe)
}

/// Reads the stored session, or `None` when there is not one.
///
/// A missing entry is not an error: it is the ordinary state of an app nobody
/// has signed into yet, and returning `Err` for it would make every launch look
/// like a failure.
#[tauri::command]
fn keychain_read() -> Result<Option<String>, String> {
    match entry()?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(describe(error)),
    }
}

#[tauri::command]
fn keychain_write(value: String) -> Result<(), String> {
    entry()?.set_password(&value).map_err(describe)
}

/// Removes the stored session.
///
/// Signing out has to succeed even when there was nothing stored — otherwise a
/// person whose entry was already gone cannot complete a sign-out, which is the
/// one action they are most likely to be doing under pressure.
#[tauri::command]
fn keychain_clear() -> Result<(), String> {
    match entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(describe(error)),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Updates are signed, and the public key in `tauri.conf.json` is what
        // makes an unsigned or foreign-signed update refuse to install. The
        // private half is never committed; CI reads it from
        // `TAURI_SIGNING_PRIVATE_KEY`.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            keychain_read,
            keychain_write,
            keychain_clear
        ])
        .run(tauri::generate_context!())
        .expect("error while running the Integr8 Plus desktop app");
}
