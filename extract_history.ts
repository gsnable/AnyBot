import * as db from './src/web/db.js';
import * as fs from 'node:fs';

async function exportSession(chatId: string, fileName: string) {
    const session = db.getSession(chatId);
    if (!session) {
        console.log(`会话 ${chatId} 未找到`);
        return;
    }
    const formatted = session.messages.map(m => {
        const role = m.role === 'user' ? 'user' : 'model';
        const content = m.content;
        let attachments = [];
        if (m.metadata) {
            try {
                const meta = JSON.parse(m.metadata);
                if (meta.attachments) {
                    attachments = meta.attachments.map((a: any) => a.path);
                }
            } catch (e) {}
        }
        
        const output: any = { [role]: content };
        if (attachments.length > 0) {
            output.attachments = attachments;
        }
        
        return JSON.stringify(output, null, 2);
    }).join('\n\n');
    fs.writeFileSync(fileName, formatted);
    console.log(`会话 ${chatId} 已导出至 ${fileName}`);
}

async function run() {
    await exportSession('1774923033319-hmg7nf', '/root/exp_turn1.json');
}

run().catch(console.error);
