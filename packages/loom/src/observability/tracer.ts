/**
 * @ownware/loom - Lightweight tracing compatible with OpenTelemetry format.
 * Uses crypto.randomUUID() for ID generation. Zero external dependencies.
 */

import { randomUUID } from 'node:crypto';

export interface SpanEvent {
  name: string;
  timestamp: number;
  attributes?: Record<string, unknown>;
}

export type SpanStatus = 'ok' | 'error' | 'unset';

export interface SpanData {
  name: string;
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  startTime: number;
  endTime: number | null;
  attributes: Record<string, unknown>;
  events: SpanEvent[];
  status: SpanStatus;
}

function generateTraceId(): string {
  return randomUUID().replace(/-/g, '').slice(0, 16);
}

function generateSpanId(): string {
  return randomUUID().replace(/-/g, '').slice(0, 8);
}

export class Span {
  private readonly data: SpanData;

  constructor(name: string, traceId: string, parentSpanId: string | null) {
    this.data = {
      name,
      traceId,
      spanId: generateSpanId(),
      parentSpanId,
      startTime: Date.now(),
      endTime: null,
      attributes: {},
      events: [],
      status: 'unset',
    };
  }

  get spanId(): string {
    return this.data.spanId;
  }

  get traceId(): string {
    return this.data.traceId;
  }

  end(): void {
    if (this.data.endTime !== null) {
      return; // already ended
    }
    this.data.endTime = Date.now();
  }

  addEvent(name: string, attributes?: Record<string, unknown>): void {
    const event: SpanEvent = { name, timestamp: Date.now() };
    if (attributes !== undefined) {
      event.attributes = attributes;
    }
    this.data.events.push(event);
  }

  setAttribute(key: string, value: unknown): void {
    this.data.attributes[key] = value;
  }

  setStatus(status: 'ok' | 'error'): void {
    this.data.status = status;
  }

  toJSON(): SpanData {
    return {
      ...this.data,
      attributes: { ...this.data.attributes },
      events: [...this.data.events],
    };
  }
}

export class Tracer {
  private readonly serviceName: string;
  private completedSpans: SpanData[] = [];
  private activeSpans: Map<string, Span> = new Map();

  constructor(serviceName: string) {
    this.serviceName = serviceName;
  }

  startSpan(name: string, parent?: Span): Span {
    const traceId = parent ? parent.traceId : generateTraceId();
    const parentSpanId = parent ? parent.spanId : null;
    const fullName = `${this.serviceName}.${name}`;

    const span = new Span(fullName, traceId, parentSpanId);
    this.activeSpans.set(span.spanId, span);

    // Wrap end() to capture completed spans automatically
    const originalEnd = span.end.bind(span);
    span.end = () => {
      originalEnd();
      if (this.activeSpans.has(span.spanId)) {
        this.activeSpans.delete(span.spanId);
        this.completedSpans.push(span.toJSON());
      }
    };

    return span;
  }

  getSpans(): SpanData[] {
    return [...this.completedSpans];
  }

  exportJSON(): string {
    return JSON.stringify({
      serviceName: this.serviceName,
      spans: this.completedSpans,
    });
  }

  reset(): void {
    this.completedSpans = [];
    this.activeSpans.clear();
  }
}
