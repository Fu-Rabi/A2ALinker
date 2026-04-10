import { StreamBuffer } from './StreamBuffer';
import { ServerChannel } from 'ssh2';
import { destroyRoom } from './db';
import { logger } from './logger';
import { resetLoopCounter, trackOutgoingMessage } from './loop-detection';
import { renderSshWalkieTalkieRules } from './protocol';

const REAPER_GRACE_PERIOD_MS = 30 * 1000; // 30 seconds

interface Participant {
    channel: ServerChannel;
    name: string;
    standby: boolean; // True when the agent has signaled [STANDBY]
    recentShortMessageCount: number;
}

// Track recent short messages for loop detection
interface RoomMeta {
    participants: Participant[];
    reaperTimer?: NodeJS.Timeout;
}

export class RoomManager {
    private rooms: Map<string, RoomMeta> = new Map();
    // O(1) reverse-lookup: channel → roomName, maintained in sync with rooms
    private channelToRoom: Map<ServerChannel, string> = new Map();
    private streamBuffer = new StreamBuffer(this.broadcastToRoom.bind(this));

    public joinRoom(roomName: string, channel: ServerChannel, participantName: string): boolean {
        if (!this.rooms.has(roomName)) {
            this.rooms.set(roomName, { participants: [] });
        }

        const meta = this.rooms.get(roomName)!;

        // Cancel pending destruction if someone joins
        if (meta.reaperTimer) {
             clearTimeout(meta.reaperTimer);
             delete meta.reaperTimer;
             logger.info(`[A2ALinker:RoomManager] Room '${roomName}' destruction aborted! Agent rejoined.`);
        }

        // Enforce hard 2-person limit per room for security
        if (meta.participants.length >= 2) {
            channel.write(`\r\nError: Room is full. Only 2 participants allowed per secure session.\r\n`);
            channel.exit(1);
            channel.end();
            return false;
        }

        meta.participants.push({ channel, name: participantName, standby: false, recentShortMessageCount: 0 });
        this.channelToRoom.set(channel, roomName);

        logger.info(`[A2ALinker:RoomManager] Agent '${participantName}' successfully joined room '${roomName}'`);

        // Inject the walkie-talkie rules
        channel.write(renderSshWalkieTalkieRules());
        channel.write(`\r\n=== Joined A2A Room (${meta.participants.length}/2 connected) ===\r\n`);

        // Notify others
        this.broadcastRaw(roomName, channel, `\r\n[SYSTEM]: Partner '${participantName}' has joined. Session is live!\r\n`);

        channel.on('data', (data: Buffer) => {
            this.streamBuffer.feedInfo(channel, data, participantName);
        });

        channel.on('close', () => {
            this.leaveRoom(roomName, channel);
        });

        return true;
    }

    private leaveRoom(roomName: string, channel: ServerChannel) {
        const meta = this.rooms.get(roomName);
        if (!meta) return;

        const index = meta.participants.findIndex(p => p.channel === channel);
        if (index !== -1 && meta.participants[index]) {
            const participantName = meta.participants[index]!.name;
            meta.participants.splice(index, 1);
            this.channelToRoom.delete(channel); // remove O(1) index entry
            this.streamBuffer.cleanup(channel);

            logger.info(`[A2ALinker:RoomManager] Agent '${participantName}' left room '${roomName}'`);
            this.broadcastRaw(roomName, channel, `\r\n[SYSTEM]: '${participantName}' has left the room. Session ended.\r\n`);
        }

        // Evict remaining participant immediately — they have no partner and cannot continue
        if (meta.participants.length === 1) {
            const remaining = meta.participants[0]!;
            remaining.channel.write(`\r\n[SYSTEM]: Your partner has disconnected. Session closed.\r\n`);
            remaining.channel.exit(0);
            remaining.channel.end();
            return;
        }

        if (meta.participants.length === 0) {
            logger.info(`[A2ALinker:RoomManager] Room '${roomName}' is empty. Starting ${REAPER_GRACE_PERIOD_MS/1000}s destruction timer.`);
            meta.reaperTimer = setTimeout(() => {
                logger.info(`[A2ALinker:RoomManager] ERADICATING abandoned room '${roomName}' and associated credentials from database.`);
                destroyRoom(roomName);
                this.rooms.delete(roomName);
            }, REAPER_GRACE_PERIOD_MS);
        }
    }

    // Called by the stream buffer when an agent finishes an output burst
    private broadcastToRoom(sourceName: string, rawData: string, sourceChannel: ServerChannel) {
        // O(1) lookup via channelToRoom index
        const targetRoom = this.channelToRoom.get(sourceChannel);
        const targetMeta = targetRoom ? this.rooms.get(targetRoom) : undefined;
        if (!targetRoom || !targetMeta) return;

        const sourceParticipant = targetMeta.participants.find(p => p.channel === sourceChannel);
        if (!sourceParticipant) return;

        // === [OVER] / [STANDBY] Protocol ===
        let data = rawData;
        let signaled: 'OVER' | 'STANDBY' | null = null;

        if (data.match(/\[STANDBY\]/i)) {
            signaled = 'STANDBY';
            data = data.replace(/\[STANDBY\]/gi, '').trim();
            sourceParticipant.standby = true;
            logger.info(`[A2ALinker:Protocol] '${sourceName}' signaled STANDBY in room '${targetRoom}'`);
        } else if (data.match(/\[OVER\]/i)) {
            signaled = 'OVER';
            data = data.replace(/\[OVER\]/gi, '').trim();
            sourceParticipant.standby = false;
            logger.info(`[A2ALinker:Protocol] '${sourceName}' signaled OVER in room '${targetRoom}'`);
        } else {
            sourceParticipant.standby = false;
        }

        // Check if ALL participants are in STANDBY — mute the room
        const allStandby = targetMeta.participants.every(p => p.standby);
        if (allStandby) {
            logger.info(`[A2ALinker:Protocol] All agents in STANDBY in room '${targetRoom}'. Session muted.`);
            this.broadcastRaw(targetRoom, null, `\r\n[SYSTEM]: Both agents have signaled STANDBY. Session paused. A human must intervene to resume.\r\n`);
        }

        // === Polite Loop Failsafe ===
        // Track per-agent short message count to avoid false positives from cross-agent brief exchanges.
        if (trackOutgoingMessage(sourceParticipant, data.length)) {
            logger.info(`[A2ALinker:Protocol] Polite loop detected in room '${targetRoom}'. Forcing STANDBY.`);
            resetLoopCounter(sourceParticipant);
            targetMeta.participants.forEach(p => p.standby = true);
            this.broadcastRaw(targetRoom, null, `\r\n[SYSTEM ALERT]: Repetitive short messages detected. Conversation forcibly paused. Human intervention required.\r\n`);
            return;
        }

        // Format the output clearly so the other agent knows who said what.
        const safeData = data.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
        const signalBadge = signaled === 'OVER' ? ' [OVER]' : signaled === 'STANDBY' ? ' [STANDBY]' : '';
        const formattedData = `\r\n\r\n┌─ ${sourceName}${signalBadge}\r\n│\r\n${safeData.split('\r\n').map(l => `│ ${l}`).join('\r\n')}\r\n└────\r\n`;

        logger.info(`[A2ALinker:Multiplexer] Routing message from '${sourceName}' in room '${targetRoom}' (${data.length} bytes) to ${targetMeta.participants.length - 1} other agent(s)`);

        for (const p of targetMeta.participants) {
            if (p.channel !== sourceChannel) {
                p.channel.write(formattedData);
                // Receiving a message resets the receiver's short-message counter.
                // A loop is defined as one agent repeating without getting any response —
                // not two agents having a back-and-forth with brief messages.
                resetLoopCounter(p);
            }
        }

        // Confirm delivery back to the sender so agents can verify the SSH pipe is alive
        // and the server actually processed + relayed the message.
        // IMPORTANT: pad to >4KB to force SSH's send buffer to flush immediately.
        // Without padding, the 13-byte [DELIVERED] sits in the SSH buffer and never
        // reaches the client's log file until the connection closes.
        const FLUSH_PAD = ' '.repeat(4096);
        sourceChannel.write(`\r\n[DELIVERED]${FLUSH_PAD}\r\n`);
    }

    // Direct broadcast to all in the room (null sourceChannel = broadcast to everyone)
    private broadcastRaw(roomName: string, sourceChannel: ServerChannel | null, text: string) {
        const meta = this.rooms.get(roomName);
        if (!meta) return;
        for (const p of meta.participants) {
            if (p.channel !== sourceChannel) {
                p.channel.write(text);
            }
        }
    }
}

export const globalRoomManager = new RoomManager();
