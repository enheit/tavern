# Streaming QoE dataset

`tavern_qoe_v1` contains anonymous five-second media-quality summaries uploaded in bounded batches.
Authentication is used only as the key for the rate-limit binding; user, room, server, session, track,
source, and IP identifiers are not written to Analytics Engine.

The index is `qoe-v1:<role>:<random 0..31 bucket>` to distribute writes without creating a stable
viewer or publisher identifier.

Blob columns:

1. role
2. platform
3. OS
4. stream kind
5. content mode
6. preset (`none` when absent)
7. codec (`unknown` when absent)
8. RID (`none` when absent)
9. limitation
10. health

Double columns:

1. target fps
2. source fps
3. encode fps
4. receive fps
5. render fps
6. width
7. height
8. bitrate kbps
9. packet loss percent
10. RTT ms
11. jitter ms
12. dropped-frame percent
13. freeze duration ms
14. sample window ms

Nullable double metrics use `-1`. Healthy samples are retained at roughly 25%; degraded samples are
retained at 100% client-side. The client sends at most one batch every 30 seconds and the Worker
allows three batches per authenticated account per minute.
