# P13 — Mobile form renderer

**Version:** v0.3 Field Loop
**Status:** `IN PROGRESS — built and verified off-device; awaiting the phone checklist`
**Depends on:** P12

## Goal

Any form built on the desktop renders and fills correctly on a phone, offline, with the
device capabilities the field actually needs.

## Scope

The React Native renderer over the P06 logic core. The builder is never ported to mobile.

## Tasks

- [x] React Native renderer driven entirely by the shared logic core — no form-specific code
- [x] Native widget for every field type in the registry, sized for gloved hands
- [x] Camera capture with compression and thumbnail generation before the file leaves the device
- [x] Signature pad tuned for a finger and a stylus
- [x] GPS capture on submit, recording accuracy radius and timestamp
- [x] Barcode and QR scanning directly into a field
- [ ] Repeating group entry that is usable on a small screen — moved to [P13b](P13b-repeating-groups.md)
- [x] Draft autosave on every change, surviving app kill and battery death
- [x] Progress indicator, section jump, and a required-field list that taps through to each error
- [x] Review screen before submit
- [x] Prefill from the previous submission for the same asset — the same form at the same site until assets exist (P24)
- [x] Voice-to-text into text fields
- [x] Submission queued through the P12 outbox, never sent directly

## Exit criteria

- [ ] A form built in P07 renders on a phone matching the builder's phone preview
- [ ] A twenty-field form with photos is completed end to end in aeroplane mode and survives an app kill mid-way
- [ ] Every field type in the registry has a working native widget
- [x] A form filled on the phone and the same form filled on the desktop produce identical stored answers

## Notes

- This is where the "share logic, not components" decision from P01 pays for itself. If
  you find yourself needing form-specific code here, the logic core is leaking UI concerns.
- Compress before queueing, not before uploading. A 12MP photo sitting in the queue is
  storage on the device as well as on your bill.

---

## Progress

Every task is built except repeating groups, which the form engine does not have. That task
moved to [P13b](P13b-repeating-groups.md), chosen before implementation.

- **Ticked:** the exit criterion "identical stored answers" is proven against the real API.
- **Not ticked:** the other three are about a phone in someone's hand, and each is proven as
  far as it can be without one. They close when
  [P13 on a phone](../../docs/mobile/device-checklist.md#p13) has been run on a development
  build.

The design is in [forms on the phone](../../docs/mobile/forms.md).

| Claim                                                        | How it was proven so far                                                                                                                                                                                                                                                                                                                                                                                                                                              | Still needs                              |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| A form built in P07 renders like the builder's phone preview | Same engine functions and the same layout rule: pages one at a time, one column, visible elements only. The app bundles for iOS and Android (`expo export`, Hermes bytecode)                                                                                                                                                                                                                                                                                          | Checklist 1, side by side                |
| Twenty questions with photos, offline, surviving a kill      | `fill-model.test.ts`: a twenty-question, three-page form is filled into the phone's real database. The model is dropped half-way and the form reopened from SQLite with every answer. Ten photos and a signature are queued. Review lists only the missing signature and opens its page. The hidden answer is not submitted. The submit waits in the outbox for its eleven files. P12's suite proves the rest of the trip, and `synchronous = FULL` covers power loss | Checklist 4 with a real kill and battery |
| Every field type has a working native widget                 | An exhaustive switch over the registry's types in `field-block.tsx` (a new type fails to compile); typecheck, lint and bundle                                                                                                                                                                                                                                                                                                                                         | Checklist 2, each widget by hand         |
| Phone and desktop store identical answers                    | API suite: a form with every field type and a calculated question is filled on the phone (outbox, uploads, sync) and on the desktop (REST). The stored answers are equal apart from file ids, and only the phone's submission has a location. Both renderers convert input through `@integr8/form-input`                                                                                                                                                              | Checklist 5 (CSV export side by side)    |
| Autosave never loses a newer answer to a save on the wire    | `forms.test.ts`: an autosave made while the previous one is marked sent becomes its own change, and a submit replaces only the unsent one. Removing the `sent_at` guard fails the test                                                                                                                                                                                                                                                                                | —                                        |
| Submit location is written only by submitting                | db lifecycle test: recorded on the row and on each history event. Refused afterwards, on a draft, or in another shape, as the owner and as the runtime role. A desktop amendment records none                                                                                                                                                                                                                                                                         | —                                        |
| Nothing else regressed                                       | Workspace lint, typecheck, unit tests and build (61 tasks). Integration: db 232, API 120 (sync 15). Unit: form-engine 440, form-input 16, offline 42, form-renderer-dom 41, i18n 36, API 105, mobile 7                                                                                                                                                                                                                                                                | —                                        |

## Decisions taken during implementation

- **Repeating groups became their own phase (P13b)**, chosen before implementation. The engine
  has no repeating element, and adding one touches the engine, builder, web renderer, server
  validation, reporting and CSV export, and needs a stored answer shape of its own.
- **Prefill from the same form at the same site**, chosen before implementation, until assets
  exist (P24). Evidence (photos, files, signatures, locations), calculated and read-only answers
  never carry over. Earlier answers move to today's version the way a draft does.
- **Voice is the keyboard's dictation**, chosen before implementation. It needs no native module
  and no permission, and works offline where the phone has an on-device model.
- **The submit-time location is submission metadata**, chosen before implementation. It is a
  column and a history field (migration 0012), sent with the phone's submit. GPS answers keep
  their shape. A refused permission or no fix is recorded and never blocks submitting.
- **`@integr8/form-input` is a new package** for what filling needs that is not a component:
  - digit handling, date-time offsets, GPS formatting and multi-select order;
  - photo sizes and file checks;
  - pages and problems, prefill, signature geometry and error wording.

  The web renderer moved onto it, so both renderers produce answers through one set of
  functions: share logic, not components.

- **`FillModel` is plain TypeScript.** The renderer's logic is unit-tested against the real local
  database without a React Native test runner. The widgets are thin.
- **Photos shrink when taken**, to the web's 2048 px at 0.82, with a 320 px thumbnail. The camera
  original is deleted, so nothing full-size waits in the queue.
- **Signatures are an SVG pad snapshotted to PNG** (`react-native-svg`, `react-native-view-shot`),
  in the web pad's 480 × 160 space, with a typed-name alternative.
- **Pickers are the platform's** (`@react-native-community/datetimepicker`). Barcode scanning is
  `expo-camera`'s, reading every common symbology.
- **The conformance corpus ships in the app** (`@integr8/form-engine/conformance`), with a
  Settings button, so the phone's own Hermes can be checked on any build.

## Deploying

- Migration `0012_submit_location`.
- A new development build is needed for the phone. The camera, image picker, location, document
  picker, SVG, view-shot and date-picker modules are native, and their permission strings are in
  `app.json`.

## Found while building this

- **An autosave could have lost the answers typed while it was being sent (P12).**
  - What went wrong: a save was folded into an outbox row the engine had already chosen and
    sent. The reply then marked the row done, so the newer answers were never sent. Resending
    that id with new content would also have been refused as a reused id.
  - Fix: the engine now marks rows as sent in the same transaction that picks them, and only
    unsent rows are folded into or replaced.
- **Captured files would have been lost on every iOS app update (P12).** The upload reader
  treated a file's path as an absolute URI, and iOS moves the app's container on update. Paths
  are now relative to the files directory, as P11's downloaded files already were.
- **Uploaded files were never deleted from the phone (P12).** Confirmed uploads stayed forever.
  They now go with their job, and so do the phone's copies of forms the server already has.
- **The settings screen's unsent count watched the wrong tables** since P12: `drafts` instead of
  the outbox and uploads. It could show a stale number until something else changed.
- **P11's upgrade check depended on a development button** that writes a P11-shaped draft. The
  device checklist now uses the committed P11 build for that step.
- **The location is not yet shown in a web component test.** The history line typechecks and its
  data is proven by the API suite, but no DOM test renders it.
