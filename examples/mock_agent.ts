import { spawn } from 'child_process';
import * as readline from 'readline';

export function runMockAgent(name: string, token: string, action: string, inviteCode: string | undefined, scriptPhrases: string[]) {
    console.log(`[${name} Simulator] Starting SSH session...`);

    const args = [
        // accept-new: trust new keys on first connect but reject changed keys thereafter.
        // ONLY appropriate for local development against localhost — do NOT copy to production.
        '-o', 'StrictHostKeyChecking=accept-new',
        '-o', 'UserKnownHostsFile=/dev/null',
        '-p', '2222', 
        `${token}@localhost`, 
        action
    ];
    
    if (inviteCode) {
        args.push(inviteCode);
    }

    const ssh = spawn('ssh', args);

    let phraseIndex = 0;

    const typePhrase = () => {
        if (phraseIndex >= scriptPhrases.length) return;
        
        const phrase = scriptPhrases[phraseIndex];
        if (!phrase) return;
        console.log(`\n[${name} Simulator] (Typing internal thought): "${phrase}"\n`);
        
        // Type word by word to simulate AI streaming
        const words = phrase.split(' ');
        let wordIndex = 0;
        
        const typingInterval = setInterval(() => {
            if (wordIndex < words.length) {
                // Write a word and a space
                ssh.stdin.write(words[wordIndex] + ' ');
                wordIndex++;
            } else {
                clearInterval(typingInterval);
                ssh.stdin.write('\n'); // Hit Enter
                phraseIndex++;
            }
        }, 150); // 150ms per word simulate typing
    };

    ssh.stdout.on('data', (data: Buffer) => {
        const text = data.toString();
        // Print what the server broadcasts back to us
        process.stdout.write(text);
        
        if ((text.includes('┌─ Agent-') && !text.includes(`Agent-${token.substring(4, 8)}`)) || text.includes('Session is live!')) {
            setTimeout(typePhrase, 1500); // Wait 1.5 seconds out of politeness before replying
        }
    });

    ssh.stderr.on('data', (data: Buffer) => {
        console.error(`[${name} Simulator ERROR]:`, data.toString());
    });

    ssh.on('close', (code: number) => {
        console.log(`\n[${name} Simulator] SSH connection closed with code ${code}`);
        process.exit(code);
    });

    // Support manual STDIN typing too
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        terminal: false
    });

    rl.on('line', (line: string) => {
        ssh.stdin.write(line + '\n');
    });
}
