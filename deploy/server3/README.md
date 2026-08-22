# Server 3 lane-only runtime

Server 3 runs one bundled `relay.js` artifact. The bundle contains the owned
HTTP/2 lane pool, authenticated byte relay, and in-memory telemetry only. It
does not import or deploy bot, login, session, API, user, or SQLite modules.

The relay accepts only origins listed by `LANE_RELAY_LINE_ORIGINS`; production
uses only `https://legy.line-apps.com`. Login/control traffic such as
`gf.line.naver.jp` stays on Server 2 and is rejected by Server 3.

Run `bash deploy-server3.sh` from the repository root after committing and
testing the working tree. The script refuses an uncommitted tree, builds the
single-file bundle, switches the release, restarts the unit, and verifies all
configured lanes are ready.
