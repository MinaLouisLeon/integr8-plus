# P13 — Mobile form renderer

**Version:** v0.3 Field Loop
**Status:** `NOT STARTED`
**Depends on:** P12

## Goal
Any form built on the desktop renders and fills correctly on a phone, offline, with the
device capabilities the field actually needs.

## Scope
The React Native renderer over the P06 logic core. The builder is never ported to mobile.

## Tasks
- [ ] React Native renderer driven entirely by the shared logic core — no form-specific code
- [ ] Native widget for every field type in the registry, sized for gloved hands
- [ ] Camera capture with compression and thumbnail generation before the file leaves the device
- [ ] Signature pad tuned for a finger and a stylus
- [ ] GPS capture on submit, recording accuracy radius and timestamp
- [ ] Barcode and QR scanning directly into a field
- [ ] Repeating group entry that is usable on a small screen
- [ ] Draft autosave on every change, surviving app kill and battery death
- [ ] Progress indicator, section jump, and a required-field list that taps through to each error
- [ ] Review screen before submit
- [ ] Prefill from the previous submission for the same asset
- [ ] Voice-to-text into text fields
- [ ] Submission queued through the P12 outbox, never sent directly

## Exit criteria
- [ ] A form built in P07 renders on a phone matching the builder's phone preview
- [ ] A twenty-field form with photos is completed end to end in aeroplane mode and survives an app kill mid-way
- [ ] Every field type in the registry has a working native widget
- [ ] A form filled on the phone and the same form filled on the desktop produce identical stored answers

## Notes
- This is where the "share logic, not components" decision from P01 pays for itself. If
  you find yourself needing form-specific code here, the logic core is leaking UI concerns.
- Compress before queueing, not before uploading. A 12MP photo sitting in the queue is
  storage on the device as well as on your bill.
