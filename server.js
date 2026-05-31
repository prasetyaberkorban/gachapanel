const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');
// [PERBAIKAN 1]: Mengimpor EditedMessage
const { NewMessage, EditedMessage } = require('telegram/events'); 
const mongoose = require('mongoose');

// Konfigurasi Environment Variables
const API_ID = parseInt(process.env.TELEGRAM_API_ID) || 31303511; 
const API_HASH = process.env.TELEGRAM_API_HASH || '59e239139ac6905f936c87d85f55d550'; 
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://foerta:SabrinaZD@foerta.bdkirjs.mongodb.net/?appName=foerta';
const PORT = process.env.PORT || 3000;
const ENV_SESSION = process.env.TELEGRAM_SESSION || "";

const BOT_USERNAME = '@PBDxbot';
const OTP_GROUP_ID = -2638899812; 

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

let activeNumber = "";

const SessionSchema = new mongoose.Schema({
    sessionKey: { type: String, default: 'telegram_userbot' },
    sessionString: String
});
const SessionModel = mongoose.model('TelegramSession', SessionSchema);

async function startSystem() {
    server.listen(PORT, () => console.log(`[WEB] Server berjalan di port ${PORT}`));

    try {
        await mongoose.connect(MONGODB_URI);
        console.log('[DB] Terhubung ke MongoDB.');

        let savedSession = await SessionModel.findOne({ sessionKey: 'telegram_userbot' });
        let sessionString = savedSession ? savedSession.sessionString : ENV_SESSION;

        if (!sessionString) {
            console.error('[TG ERROR] String Session tidak ditemukan!');
            return;
        }

        const stringSession = new StringSession(sessionString);
        const client = new TelegramClient(stringSession, API_ID, API_HASH, { connectionRetries: 5 });

        console.log('[TG] Menghubungkan ke Telegram...');
        await client.connect(); 
        console.log('[TG] Connected!');

        if (!savedSession && ENV_SESSION) {
            await SessionModel.create({ sessionKey: 'telegram_userbot', sessionString: ENV_SESSION });
        }

        let botIdStr = "";
        try {
            const botEntity = await client.getEntity(BOT_USERNAME);
            botIdStr = botEntity.id.toString();
            console.log(`[TG] Bot ID: ${botIdStr}`);
        } catch (e) {
            console.error(`[TG ERROR] Gagal mendapatkan ID bot.`);
        }

        // --- FUNGSI PEMROSES PESAN BOT ---
        const processBotMessage = (message) => {
            if (!message) return;
            const text = message.message || "";
            
            let chatIdStr = "";
            if (message.peerId) {
                if (message.peerId.userId) chatIdStr = message.peerId.userId.toString();
            }

            if (chatIdStr === botIdStr) {
                // Ekstrak Tombol Inline
                let buttonsArr = [];
                if (message.replyMarkup && message.replyMarkup.rows) {
                    message.replyMarkup.rows.forEach(row => {
                        let rowButtons = [];
                        row.buttons.forEach(btn => {
                            rowButtons.push({
                                text: btn.text,
                                data: btn.data ? btn.data.toString('base64') : null, 
                                url: btn.url || null
                            });
                        });
                        buttonsArr.push(rowButtons);
                    });
                }

                // Kirim ke Web
                io.emit('bot_message', { 
                    messageId: message.id, 
                    text: text, 
                    buttons: buttonsArr 
                });
            }
        };

        // --- EVENT HANDLERS ---
        // 1. Menangkap pesan baru
        client.addEventHandler(async (event) => {
            processBotMessage(event.message);
        }, new NewMessage({ incoming: true }));

        // [PERBAIKAN 2]: Menangkap pesan yang di-edit menggunakan event yang benar
        client.addEventHandler(async (event) => {
            processBotMessage(event.message);
        }, new EditedMessage({ incoming: true }));

        // --- SOCKET.IO WEB ---
        io.on('connection', (socket) => {
            socket.on('send_command', async (command) => {
                try {
                    await client.sendMessage(BOT_USERNAME, { message: command });
                } catch (err) {
                    console.error('[TG ERROR]', err);
                }
            });

            socket.on('click_inline_button', async (payload) => {
                try {
                    const callbackData = Buffer.from(payload.data, 'base64');
                    await client.invoke(new Api.messages.GetBotCallbackAnswer({
                        peer: BOT_USERNAME,
                        msgId: payload.messageId,
                        data: callbackData
                    }));
                } catch (err) {
                    console.error('[TG ERROR]', err);
                }
            });
        });

    } catch (error) {
        console.error('[SYSTEM ERROR]', error);
    }
}

startSystem();
