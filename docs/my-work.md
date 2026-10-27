# My Work

`GET /api/v1/work/me` is the signed-in person's bounded action queue. It answers
what they can act on now, rather than recording what happened. Notifications remain
the activity feed and are not removed by reading them.

## Qualification

The API batch-loads the caller's visible assets and current workflow records, then
delegates state and action selection to the existing asset workflow resolver. An item
exists only when that resolver returns a permission-aware next action. This covers
inspection start/continue/rework/review, actionable scheduling and rescheduling, asset
setup or rebooking, and certificate issuance. Settled records and ordinary future
appointments are excluded.

## Scope, deduplication, and priority

Customer users are restricted to authorized customers, while inspectors are restricted
to confirmed assignments. The endpoint applies scope before loading workflow records. A
concrete action is deduplicated by its action code, semantic target type, and target
record. Different actions never share a key.

Overdue, changes-required, and staff reschedule requests are `URGENT`; due work, review
work, and scheduling confirmation work are `DUE_SOON`; remaining actions are `NORMAL`.
Results order by priority, then existing due or scheduled time, then the activity time
of the record that owns the action (inspection, booking/change request, or asset/schedule)
and stable action ID.

The initial response scans at most 500 visible assets and returns at most the requested
100 actions. `source_limited` says when the source scan reached that bound, so counts
are never presented as a claim about records beyond it. An empty partial result is shown
as incomplete rather than claiming the person is caught up.

## Staff presentation

The Staff `?view=my-work` page renders server-provided state, priority, and semantic
next-action metadata. It maps that metadata through the existing route layer; it does
not receive or trust database-stored URLs. It polls every 45 seconds while visible, has
one request at a time, keeps stale work on refresh failure, and queues an explicit
refresh that arrives while a request is running.
