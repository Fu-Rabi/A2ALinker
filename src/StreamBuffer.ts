import { ServerChannel } from 'ssh2';

/**
 * StreamBuffer — SSH transport only.
 *
 * SSH streams raw keystroke data: each word or character arrives as a tiny
 * Buffer chunk. StreamBuffer accumulates these chunks and only flushes once
 * the agent appears to have finished speaking (either an [OVER]/[STANDBY]
 * signal is detected, the buffer hits the 128KB cap, or 500ms of silence).
 *
 * The HTTP transport does NOT use StreamBuffer. An HTTP /send call delivers
 * a complete, pre-composed message body in a single atomic POST — there is
 * no partial-data problem to buffer against. The two transports therefore
 * have intentionally divergent timing semantics:
 *   • SSH:  debounced, up to 500ms latency before relay
 *   • HTTP: instant relay upon POST receipt
 */
export class StreamBuffer {
    private buffers: Map<ServerChannel, Buffer> = new Map();
    private debounceTimers: Map<ServerChannel, NodeJS.Timeout> = new Map();
    
    // We notify this callback when a chunk of text is fully ready
    private onFlush: (sourceName: string, data: string, sourceChannel: ServerChannel) => void;

    // How long to wait before deciding an agent is "done talking"
    private debounceMs = 500;
    private readonly maxBufferBytes = 128 * 1024;

    constructor(onFlush: (sourceName: string, data: string, sourceChannel: ServerChannel) => void) {
        this.onFlush = onFlush;
    }

    public feedInfo(channel: ServerChannel, data: Buffer, sourceName: string) {
        if (!this.buffers.has(channel)) {
            this.buffers.set(channel, Buffer.alloc(0));
        }

        const currentBuffer = this.buffers.get(channel)!;
        const newBuffer = Buffer.concat([currentBuffer, data]);
        this.buffers.set(channel, newBuffer);

        // Flush immediately if buffer exceeds size cap — no need to wait for debounce
        if (newBuffer.length >= this.maxBufferBytes) {
            if (this.debounceTimers.has(channel)) {
                clearTimeout(this.debounceTimers.get(channel)!);
                this.debounceTimers.delete(channel);
            }
            this.flush(channel, sourceName);
            return;
        }

        // Flush immediately if the agent has signaled end-of-turn.
        // Check the accumulated buffer (not just the new chunk) to handle signals split across TCP packets.
        // The debounce remains as fallback for agents that omit the signal.
        if (/\[OVER\]/i.test(newBuffer.toString('utf-8')) || /\[STANDBY\]/i.test(newBuffer.toString('utf-8'))) {
            if (this.debounceTimers.has(channel)) {
                clearTimeout(this.debounceTimers.get(channel)!);
                this.debounceTimers.delete(channel);
            }
            this.flush(channel, sourceName);
            return;
        }

        // Clear existing timer
        if (this.debounceTimers.has(channel)) {
            clearTimeout(this.debounceTimers.get(channel)!);
        }

        // Set new timer
        this.debounceTimers.set(channel, setTimeout(() => {
            this.flush(channel, sourceName);
        }, this.debounceMs));
    }

    private flush(channel: ServerChannel, sourceName: string) {
        const data = this.buffers.get(channel);
        if (data && data.length > 0) {
            this.onFlush(sourceName, data.toString('utf-8'), channel);
            this.buffers.set(channel, Buffer.alloc(0)); // Reset
        }
    }

    public cleanup(channel: ServerChannel) {
        if (this.debounceTimers.has(channel)) {
            clearTimeout(this.debounceTimers.get(channel)!);
            this.debounceTimers.delete(channel);
        }
        this.buffers.delete(channel);
    }
}
