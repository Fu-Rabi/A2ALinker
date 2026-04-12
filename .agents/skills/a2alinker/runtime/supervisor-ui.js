"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getDefaultRenderOptions = getDefaultRenderOptions;
exports.renderUiEvent = renderUiEvent;
const ANSI = {
    reset: '\u001b[0m',
    bold: '\u001b[1m',
    dim: '\u001b[2m',
    cyan: '\u001b[36m',
    green: '\u001b[32m',
    yellow: '\u001b[33m',
    red: '\u001b[31m',
    blue: '\u001b[34m',
    magenta: '\u001b[35m',
    white: '\u001b[37m',
};
function getDefaultRenderOptions(input) {
    const stdout = process.stdout;
    const tty = Boolean(stdout?.isTTY);
    const plainMode = input?.plainMode ?? !tty;
    const colorEnabled = input?.colorEnabled ?? (!plainMode && tty && !process.env['NO_COLOR']);
    const timestampEnabled = input?.timestampEnabled ?? tty;
    const width = clampWidth(input?.width ?? stdout?.columns ?? 80);
    return {
        colorEnabled,
        width,
        timestampEnabled,
        plainMode,
    };
}
function renderUiEvent(event, options) {
    switch (event.type) {
        case 'session':
            return renderSessionEvent(event, options);
        case 'notice':
            return event.layout === 'card'
                ? renderNoticeCard(event, options)
                : renderNoticeLine(event, options);
        case 'message':
            return renderMessageEvent(event, options);
    }
}
function renderSessionEvent(event, options) {
    const rows = [
        ['Agent', event.agentLabel],
        ['Role', event.role.toUpperCase()],
        ['Mode', event.mode.toUpperCase()],
        ['Headless', String(event.headless)],
    ];
    if (event.goal) {
        rows.push(['Goal', event.goal]);
    }
    if (event.code) {
        rows.push(['Code', event.code]);
    }
    rows.push(['Status', event.detail]);
    const accent = sessionAccent(event.stage);
    return renderCard(event.title, rows, options, accent);
}
function renderNoticeCard(event, options) {
    const rows = [['Status', event.detail]];
    if (event.meta) {
        for (const metaLine of event.meta) {
            rows.push(['Info', metaLine]);
        }
    }
    return renderCard(event.label, rows, options, noticeAccent(event.level));
}
function renderNoticeLine(event, options) {
    const pieces = [timestampPrefix(options), colorize(event.label, noticeAccent(event.level), options)];
    pieces.push(event.detail);
    if (event.meta && event.meta.length > 0) {
        pieces.push(`(${event.meta.join(' | ')})`);
    }
    return pieces.filter(Boolean).join('  ');
}
function renderMessageEvent(event, options) {
    const directionLabel = event.direction === 'inbound' ? 'INBOUND' : 'OUTBOUND';
    const accent = event.direction === 'inbound' ? ANSI.cyan : ANSI.green;
    const availableWidth = innerWidth(options);
    const headerParts = [directionLabel, event.speaker];
    if (event.signal) {
        headerParts.push(`[${event.signal}]`);
    }
    const header = headerParts.join('  ');
    const headerText = `${timestampPrefix(options)}${header}`.trim();
    const wrappedBody = wrapParagraphs(event.body || '', availableWidth - 2);
    const lines = [
        colorize(`┌─ ${headerText}`, accent, options),
        ...wrappedBody.map((line) => `│ ${line}`),
        colorize(`└${'─'.repeat(Math.max(3, visibleLength(`┌─ ${headerText}`) - 1))}`, accent, options),
    ];
    return lines.join('\n');
}
function renderCard(title, rows, options, accent) {
    const width = innerWidth(options);
    const labelWidth = Math.min(10, Math.max(6, ...rows.map(([label]) => label.length)));
    const lines = [];
    lines.push(colorize(`╭─ ${title} ${'─'.repeat(Math.max(2, width - visibleLength(title) - 3))}╮`, accent, options));
    for (const [label, value] of rows) {
        const valueWidth = Math.max(10, width - labelWidth - 3);
        const wrappedValue = wrapParagraphs(value, valueWidth);
        wrappedValue.forEach((line, index) => {
            const displayLabel = index === 0 ? padEnd(label, labelWidth) : ' '.repeat(labelWidth);
            lines.push(`│ ${displayLabel} ${padEnd(line, valueWidth)} │`);
        });
    }
    lines.push(colorize(`╰${'─'.repeat(width)}╯`, accent, options));
    return lines.join('\n');
}
function wrapParagraphs(text, width) {
    const safeWidth = Math.max(10, width);
    const paragraphs = text.split('\n');
    const lines = [];
    for (const paragraph of paragraphs) {
        if (!paragraph.trim()) {
            lines.push('');
            continue;
        }
        const words = paragraph.split(/\s+/);
        let current = '';
        for (const word of words) {
            if (!current) {
                current = word;
                continue;
            }
            if (visibleLength(current) + 1 + visibleLength(word) <= safeWidth) {
                current += ` ${word}`;
                continue;
            }
            lines.push(...hardWrap(current, safeWidth));
            current = word;
        }
        if (current) {
            lines.push(...hardWrap(current, safeWidth));
        }
    }
    return lines.length > 0 ? lines : [''];
}
function hardWrap(text, width) {
    if (visibleLength(text) <= width) {
        return [text];
    }
    const out = [];
    let remaining = text;
    while (visibleLength(remaining) > width) {
        out.push(remaining.slice(0, width));
        remaining = remaining.slice(width);
    }
    if (remaining) {
        out.push(remaining);
    }
    return out;
}
function timestampPrefix(options) {
    if (!options.timestampEnabled) {
        return '';
    }
    const now = new Date();
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const seconds = String(now.getSeconds()).padStart(2, '0');
    return `[${hours}:${minutes}:${seconds}] `;
}
function colorize(text, color, options) {
    if (!options.colorEnabled) {
        return text;
    }
    return `${color}${ANSI.bold}${text}${ANSI.reset}`;
}
function noticeAccent(level) {
    switch (level) {
        case 'warn':
            return ANSI.yellow;
        case 'error':
            return ANSI.red;
        case 'info':
            return ANSI.blue;
    }
}
function sessionAccent(stage) {
    switch (stage) {
        case 'starting':
            return ANSI.magenta;
        case 'code-ready':
            return ANSI.blue;
        case 'live':
            return ANSI.green;
    }
}
function innerWidth(options) {
    return clampWidth(options.width) - 2;
}
function clampWidth(width) {
    return Math.max(40, Math.min(100, Math.floor(width)));
}
function visibleLength(text) {
    return text.length;
}
function padEnd(text, width) {
    const missing = Math.max(0, width - visibleLength(text));
    return `${text}${' '.repeat(missing)}`;
}
//# sourceMappingURL=supervisor-ui.js.map