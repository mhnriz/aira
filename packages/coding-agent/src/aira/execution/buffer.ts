/**
 * Aira execution — bounded output buffers.
 *
 * Each managed process keeps one bounded buffer per stream (stdout/stderr).
 * Buffers retain the TAIL of the stream up to a byte cap; when the cap is
 * exceeded, the oldest content is dropped and the buffer is marked truncated.
 * This keeps memory bounded for long-running processes (dev servers!) while
 * preserving the recent output that matters for diagnosis.
 *
 * Decoding and sanitization happen at append time (the manager decodes raw
 * bytes with a streaming TextDecoder and strips ANSI/control garbage), so the
 * buffer only ever holds clean text.
 */

export interface OutputBufferSnapshot {
	/** Bounded tail text (may be empty). */
	text: string;
	/** True when bytes were dropped because the cap was exceeded. */
	truncated: boolean;
	/** Total bytes received over the lifetime of this buffer (pre-drop). */
	totalBytes: number;
	/** Bytes dropped from the head due to the cap. */
	droppedBytes: number;
}

export class BoundedOutputBuffer {
	private readonly chunks: string[] = [];
	private bytes = 0;
	private totalBytes = 0;
	private droppedBytes = 0;
	private truncated = false;
	private readonly maxBytes: number;

	constructor(maxBytes: number) {
		this.maxBytes = maxBytes;
	}

	/** Append decoded, sanitized text. Bounded: drops from the head on overflow. */
	append(text: string): void {
		if (text.length === 0) {
			return;
		}
		this.totalBytes += Buffer.byteLength(text);
		this.chunks.push(text);
		this.bytes += Buffer.byteLength(text);
		while (this.bytes > this.maxBytes && this.chunks.length > 1) {
			const dropped = this.chunks.shift()!;
			this.bytes -= Buffer.byteLength(dropped);
			this.droppedBytes += Buffer.byteLength(dropped);
			this.truncated = true;
		}
	}

	/** Full retained content (bounded by the cap). */
	text(): string {
		return this.chunks.join("");
	}

	/** Tail of the retained content, capped to `maxChars` characters. */
	tail(maxChars: number): { text: string; truncated: boolean } {
		const full = this.text();
		if (full.length <= maxChars) {
			return { text: full, truncated: false };
		}
		return { text: full.slice(-maxChars), truncated: true };
	}

	snapshot(): OutputBufferSnapshot {
		return {
			text: this.text(),
			truncated: this.truncated,
			totalBytes: this.totalBytes,
			droppedBytes: this.droppedBytes,
		};
	}
}

/** Default per-stream byte cap: 128 KiB. */
export const DEFAULT_EXECUTION_LOG_BYTES = 128 * 1024;
