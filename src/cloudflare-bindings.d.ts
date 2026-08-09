import type { OutboxDispatchMessage } from './application/ports';

declare global {
  interface Env {
    EXPORTS_BUCKET?: R2Bucket;
    EVENT_QUEUE?: Queue<OutboxDispatchMessage>;
  }

  namespace Cloudflare {
    interface Env {
      EXPORTS_BUCKET?: R2Bucket;
      EVENT_QUEUE?: Queue<OutboxDispatchMessage>;
    }
  }
}

export {};
