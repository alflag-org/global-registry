/** Current on-disk format for chunked portable registry exports. */
export const PORTABLE_EXPORT_SCHEMA_VERSION = '1.3' as const;

/** Maximum number of export processing claims before one stale-lease recovery. */
export const MAX_EXPORT_ATTEMPTS = 5;

/** Queue consumer deliveries include one recovery delivery after export claims are exhausted. */
export const MAX_OUTBOX_CONSUMER_ATTEMPTS = MAX_EXPORT_ATTEMPTS + 1;

/** Queue.send failures are retried locally before the outbox row is terminalized. */
export const MAX_OUTBOX_PRODUCER_ATTEMPTS = 3;

/** Maximum rows selected by one outbox dispatch invocation. */
export const MAX_OUTBOX_DISPATCH_WORK = 100;

/** Maximum observations archived by one scheduled invocation. */
export const MAX_OBSERVATION_ARCHIVE_WORK = 100;

/** Maximum expired export objects deleted by one scheduled invocation. */
export const MAX_EXPORT_RETENTION_WORK = 100;

/** Export records remain available in R2 for this many days after completion. */
export const MAX_EXPORT_RETENTION_AGE_DAYS = 365;

/** Maximum rows read from D1 and serialized into one portable export chunk. */
export const MAX_PORTABLE_EXPORT_ROWS_PER_CHUNK = 1_000;
export const PORTABLE_EXPORT_QUERY_LIMIT = MAX_PORTABLE_EXPORT_ROWS_PER_CHUNK;

/** Serialized UTF-8 ceiling for each independently written portable export object. */
export const MAX_PORTABLE_EXPORT_OBJECT_BYTES = 16 * 1024 * 1024;
