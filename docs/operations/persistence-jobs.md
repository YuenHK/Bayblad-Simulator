# Persistence job policy

- Room projection jobs retry ten times with bounded exponential backoff. A tenth failure enters `dead`; it is retained for 30 days for investigation. Production monitoring must alert whenever `room_projection_jobs.status = 'dead'` is non-zero. Closed-room projections use the same outbox and revision fence.
- Match completion jobs retry ten claimed attempts. A tenth failure is retained with `MATCH_RETRY_EXHAUSTED` and is manual-retry only; production monitoring must alert on these rows. Completed job envelopes may be deleted after seven days because authoritative matches and rounds remain permanent.
- Admin audit outbox entries retry with bounded exponential backoff and remain until an idempotent append succeeds. Monitoring must alert on an oldest pending age above five minutes.
- Cleanup must run in bounded batches and must never delete pending, leased, retryable, or dead-letter rows before their stated retention period.
