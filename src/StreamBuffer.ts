import { ServerChannel } from 'ssh2';

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
