# P14 — Job execution on mobile

**Version:** v0.3 Field Loop
**Status:** `NOT STARTED`
**Depends on:** P13

## Goal
An engineer runs their entire working day from the phone, from opening the app to
closing the last job.

## Scope
The screens and flows an engineer actually touches. This phase completes the core loop
the whole product is built around.

## Tasks
- [ ] Today view: next job, the day's list, travel status — the screen that opens ninety percent of the time
- [ ] Job detail: site access notes first, then instructions, forms, checklist and attachments
- [ ] One-tap navigation handing the address to the phone's maps app
- [ ] Clock in and out; travel start and stop, recorded against the job
- [ ] Status transitions from the job screen, respecting the server state machine
- [ ] Before and after photo prompts driven by the job type
- [ ] Customer signature on completion, with name, role and timestamp
- [ ] Completion flow blocking on unsubmitted required forms, explaining exactly what is missing
- [ ] Push notifications for new assignments, schedule changes and urgent callouts
- [ ] Biometric or PIN app lock for fast re-entry
- [ ] Crash reporting with an offline buffer, uploaded when signal returns
- [ ] Over-the-air update channel via EAS Update

## Exit criteria
- [ ] A real engineer completes a real day of work using only the phone, observed, with notes taken
- [ ] Every completed job arrives on the server with its forms, photos, signature and times intact
- [ ] Reopening the app after a forced close returns to exactly where the engineer was
- [ ] A push notification for a new assignment arrives within thirty seconds

## Notes
- Watch a real engineer use this before declaring it done. Every field service product
  that failed was designed by someone who never stood in a plant room holding a phone.
- The completion block on missing forms is the most-hit error in the product. Its wording
  is worth iterating on.
