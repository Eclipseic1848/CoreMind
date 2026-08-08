import { randomUUID } from "node:crypto";
import type { CoreMindEvent } from "./events.js";

/** 可持久化、可跨 SDK 对齐的一条运行轨迹。 */
export interface CoreMindTraceEvent {
  eventId: string;
  runId: string;
  sequence: number;
  timestamp: string;
  event: CoreMindEvent;
}

export class TraceRecorder {
  private sequence: number;
  readonly entries: CoreMindTraceEvent[];

  constructor(
    readonly runId: string,
    private readonly forward?: (entry: CoreMindTraceEvent) => void,
    initialEntries: CoreMindTraceEvent[] = [],
  ) {
    this.entries = [...initialEntries];
    this.sequence = initialEntries.reduce((highest, entry) => Math.max(highest, entry.sequence), 0);
  }

  record(event: CoreMindEvent): CoreMindTraceEvent {
    const entry: CoreMindTraceEvent = {
      eventId: randomUUID(),
      runId: this.runId,
      sequence: ++this.sequence,
      timestamp: new Date().toISOString(),
      event,
    };
    this.entries.push(entry);
    this.forward?.(entry);
    return entry;
  }
}
