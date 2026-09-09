# P11 — Mobile shell and local database

**Version:** v0.3 Field Loop
**Status:** `NOT STARTED`
**Depends on:** P05, P10

## Goal
The mobile app holds a local mirror of the engineer's work and renders entirely from it,
never waiting on the network.

## Scope
Local persistence and the read path. Synchronisation is P12.

## Tasks
- [ ] SQLite on device (`expo-sqlite` or `op-sqlite`) with a migration mechanism of its own
- [ ] Local schema mirroring the server tables the engineer needs — jobs, customers, sites, forms, drafts, files
- [ ] Local repository layer; screens read from SQLite only and never call the API directly
- [ ] Reactive queries so the UI updates when local data changes
- [ ] Local database versioning and a safe upgrade path for an app updated after weeks offline
- [ ] Encrypted storage for the local database
- [ ] Wipe-on-signout, and remote wipe when a device is revoked
- [ ] Storage budget: how much history is kept on device, and what is evicted first
- [ ] Local full-text search over jobs and customers

## Exit criteria
- [ ] Every screen renders with the network disabled and the device in aeroplane mode
- [ ] No screen shows a network spinner for data that exists locally
- [ ] Upgrading the app across two local schema versions preserves all unsent work
- [ ] Signing out leaves no readable company data on the device

## Notes
- The local schema does not have to match the server schema. Optimise it for the phone's
  read patterns — the sync layer in P12 is the translator.
- Decide the eviction policy now. An engineer with three years of history will otherwise
  fill their phone.
