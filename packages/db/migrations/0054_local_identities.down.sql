-- Reverses 0054. Deletes every locally kept password: for development
-- databases only. On a server that signs people in with IDENTITY_PROVIDER=local,
-- nobody in any company could sign in afterwards.

drop table if exists identity_magic_links;
drop table if exists identities;
