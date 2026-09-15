# Forms on the phone

Any form built on the desktop fills correctly on a phone, offline, with the camera, a finger
and the GPS (P13). Nothing in the phone's renderer knows about any particular form.

```
@integr8/form-engine     what a form is and what it decides — the same on the phone, the web and the server
@integr8/form-input      turning a touch into an answer, photo sizes, pages, prefill — shared with the web renderer
        │
apps/mobile/src/forms
  fill-model.ts          the engine's state, pages, review and autosave, without React     ← unit tested
  form-filler.tsx        progress, contents, the problem list, review, submit
  field-block.tsx        a question: label, help, errors, and the widget for its type
  widgets/*              one native control per field type, sized for gloved hands
  capture.ts             camera, photo library, files, signature snapshot, GPS
  media.tsx              captured files → the upload queue; showing them from the phone
  session.ts             starting (and prefilling), submitting — all local
        │
@integr8/offline         submissions, outbox, uploads (P12): the sync engine sends it all later
```

P01's rule is share logic, not components. The DOM renderer and this one share
`@integr8/form-engine` and `@integr8/form-input`, and no widget. Both renderers turn a typed
"٤٢", a ticked option, a GPS fix or a picked date and time into an answer through the same
functions, which is why a form filled on either stores the same bytes. The API's sync suite
fills one form with every field type both ways and compares what the server stored.

---

## Filling

`FillModel` holds the engine's `FormState`. Everything the screen shows — which questions
show, what is worked out, what is wrong, progress, one problem per question and which page
it is on — is derived from it on each change, the way the web renderer does it.

- **One page at a time, one column**, as the builder's phone preview shows it. **Contents**
  lists every page with its problem count and each titled section, and jumps to any.
- **Review answers** checks the whole form. With problems, the list above the form names
  each question, with a link that opens its page and scrolls to it, and the screen reader
  announces how many there are. Without problems, the review screen shows exactly what will
  be submitted: the engine's `toSubmission`, so a question hidden since it was answered is
  not sent.
- **Correcting** a reopened submission asks why before submitting, as on the web.
- A **submitted** form opens read-only.

### Entries, one at a time

A repeatable section (P13b) is a list of its entries; adding or tapping one opens it on its
own, with only its questions, and the way to the next, to move it and to remove it. See
[repeating groups](../form-engine/repeating-groups.md#on-a-screen).

## Every change is saved

Each accepted answer is written straight away through `recordAnswers`: the phone's
`submissions` row and the outbox, in one SQLite transaction. Saves never overlap. While one
is being written, only the latest answers wait, so fast typing is one write per settled
burst, not one per keystroke. The header says _Saved on this phone_.

- **App killed:** at most the write in progress that moment is lost. The form reopens from
  the phone with everything else.
- **Battery dies:** the database runs with `PRAGMA synchronous = FULL`, so a commit has
  reached the disk before it returns.
- **Saving while a save is sending:** the engine marks changes as sent in the same
  transaction that chooses them (`outbox.sent_at`). An autosave is folded only into a change
  that has not left, never into one the server may already have applied under its id.

## Widgets

Every field type in the engine's registry has one. The switch in `field-block.tsx` is
exhaustive, so a new type fails to compile until the phone can answer it.

| Type                                | On the phone                                                                                                                  |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `text`, `long_text`                 | Text box. **Voice** is the keyboard's own dictation (below)                                                                   |
| `barcode`                           | Text box and **Scan**: the camera reads QR, Code 128/39/93, EAN, UPC, ITF, Data Matrix, PDF417, Aztec, Codabar into the field |
| `number`, `decimal`                 | Numeric keyboard, Arabic and Persian digits accepted, unit beside                                                             |
| `date`, `time`, `datetime`          | The platform's pickers; a date-time stored with the phone's UTC offset on that day                                            |
| `dropdown`                          | A sheet of whole-width rows                                                                                                   |
| `radio`, `multi_select`, `checkbox` | Whole-width rows at least 56 points tall                                                                                      |
| `yes_no`, `rating`                  | Large segmented buttons                                                                                                       |
| `signature`                         | Finger or stylus pad, or a typed name; saved as a PNG                                                                         |
| `photo`                             | **Take a photo** or **Choose from this phone**; made smaller, with a thumbnail, before queueing                               |
| `file`                              | The system file picker, filtered to the question's types                                                                      |
| `gps`                               | **Use my current location**, or typed coordinates                                                                             |
| calculated                          | Shown, marked as worked out, never editable                                                                                   |

Nothing tappable is under 56 points. Text is 18 points. Choices are whole rows, not circles.
Everything uses `start`/`end` and `textAlign: 'auto'`, so a form in Arabic mirrors.

### Voice

A text question takes dictation from the microphone on the iOS and Android keyboards. It works
offline where the phone has an on-device speech model, and asks for no permission. The field
says so once, and nothing dictation needs is switched off (a barcode field turns off
autocorrect, as a serial should).

### Photos: smaller before queueing

A 12 MP photo waiting in the queue is space on the phone as well as on the bill, so the
original is replaced as soon as it is taken:

- longest edge 2048 px, JPEG at 0.82 (a PNG stays a PNG), `@integr8/form-input`'s numbers for
  every renderer;
- a 320 px thumbnail, kept on the phone, so thirty photos scroll smoothly;
- the camera's own file is deleted; a photo chosen from the library is left in the library.

The question's limits (count, size, types) are checked on what will be sent, after
shrinking. Files go under `captures/` in the files directory, **by a path relative to it**:
iOS moves the app's container when the app is updated, so an absolute path would lose every
file.

A file removed from an answer has its upload dropped, but only once the answers without it
are saved, only if it has not started uploading, and only if nothing else on the phone names
it. Uploaded files and their thumbnails stay while their job is on the phone, and go with it.

### Signatures

The pad takes the touch as it lands and does not give it back to the scrolling form. Points
closer than 1.5 px are dropped. It draws in the same 480 × 160 space as the web pad and is
saved at twice that size, so signatures from either look alike on a certificate. **Type my
name instead** draws the typed name into the same image, for anyone who cannot draw one.

## Submitting

1. **Review answers**, then **Submit**.
2. **Where the phone is**, recorded with the submission, not in the answers:
   `{ status: 'captured', latitude, longitude, accuracyMeters, capturedAt }`, or
   `{ status: 'denied' }` / `{ status: 'unavailable' }`. A fix under a minute old and within
   50 m is used at once; otherwise the GPS gets up to 20 seconds, with **Submit without it**.
   GPS needs no signal. A basement may give no fix, and the form matters more.
3. `recordSubmit` puts the answers, the day it was filled and the location in the outbox.
   It waits there until every photo, file and signature it names has uploaded.
4. The phone asks for a sync and returns to the job.

The server corrects `capturedAt` by the phone's clock the same way it corrects `recordedAt`.
It stores the location on `submissions.submit_location` and on the history event.
Migration 0012 lets it be written only by submitting. The web shows it in the submission's
history, with a map link.

## Starting from earlier answers

Assets arrive in P24. Until then, a form started on a job offers to start from **the most
recent submitted answers to the same form at the same site** that the phone holds:

- `prefillAnswers` moves the answers to today's version the way a draft is migrated. A removed
  question or option is dropped, and a value the new rules reject is kept to be fixed.
- **Evidence never carries over** — photos, files, signatures, locations — nor calculated or
  read-only answers.
- The form opens saying how many answers came from which job, to be checked before submitting.

Only what is on the phone counts: this engineer's submissions for jobs still kept (open, or
closed within 30 days), with their form version. P24 moves this to the asset.

## The engine on the device

**Settings → Check the form engine** runs the conformance corpus in the app and compares
every decision with the golden file the server's tests use (`@integr8/form-engine/conformance`).
That is the phone's own Hermes and the release build's own bytecode, which CI's command-line
Hermes is not. Support can ask for it on any phone.

## Tests

- `apps/mobile/src/forms/fill-model.test.ts`: a twenty-question form over three pages, filled
  through `FillModel` into the phone's real database (Node SQLite).
  - The app is killed half-way and reopened with nothing lost.
  - Ten photos and a signature are queued.
  - Review lists only the missing signature and opens its page.
  - The hidden answer is not submitted.
  - The submit waits in the outbox for its eleven files.
- `packages/form-input`: every conversion both renderers use.
- `packages/offline/src/forms.test.ts`:
  - job forms, sessions, earlier answers;
  - photos leaving with their job;
  - dropping a removed photo's upload;
  - the autosave race.
- `apps/api/src/sync/sync.integration.test.ts`: the same every-type form, filled on the phone
  (outbox, uploads) and on the desktop (REST), stores identical answers; only the phone
  records a location.
- Camera, GPS, the keyboard, the pad, a real kill and a real battery: the
  [device checklist](device-checklist.md#p13).
