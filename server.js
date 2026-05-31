const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { NewMessage } = require('telegram/events'); // Hapus EditedMessage
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

        // Simpan Entity Bot secara global
        let botEntity = null;
        let botIdStr = "";
        try {
            botEntity = await client.getEntity(BOT_USERNAME);
            botIdStr = botEntity.id.toString();
            console.log(`[TG] Identitas Bot didapatkan. ID: ${botIdStr}`);
        } catch (e) {
            console.error(`[TG ERROR] Gagal mendapatkan identitas bot.`);
        }

        // --- FUNGSI PEMROSES PESAN BOT ---
        const processBotMessage = (message) => {
            if (!message) return;
            const text = message.message || "";
            
            // Cek pengirim pesan
            let chatIdStr = "";
            if (message.peerId) {
                if (message.peerId.userId) chatIdStr = message.peerId.userId.toString();
                // Antisipasi struktur Raw Update
                else if (message.peerId.className === 'PeerUser') chatIdStr = message.peerId.userId.toString(); 
            }

            if (chatIdStr === botIdStr) {
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

                io.emit('bot_message', { 
                    messageId: message.id, 
                    text: text, 
                    buttons: buttonsArr 
                });
            }
        };

        // --- EVENT HANDLERS ---
        
        // 1. Menangkap pesan BARU dari bot
        client.addEventHandler(async (event) => {
            processBotMessage(event.message);
        }, new NewMessage({ incoming: true }));

        // 2. Menangkap pesan DIEDIT menggunakan metode Raw API (Anti-Crash)
        client.addEventHandler(async (update) => {
            if (update.className === 'UpdateEditMessage' || update.className === 'UpdateEditChannelMessage') {
                processBotMessage(update.message);
            }
        });


        // --- SOCKET.IO WEB ---
        io.on('connection', (socket) => {
            console.log('[WEB] Perangkat baru mengakses web dashboard.');

            socket.on('send_command', async (command) => {
                try {
                    console.log(`[WEB] Mengirim pesan ke bot: ${command}`);
                    await client.sendMessage(botEntity || BOT_USERNAME, { message: command });
                    console.log(`[TG] Pesan berhasil dikirim!`);
                } catch (err) {
                    console.error('[TG ERROR] Gagal mengirim pesan:', err);
                }
            });

            socket.on('click_inline_button', async (payload) => {
                try {
                    console.log(`[WEB] Mengirim klik tombol (Pesan ID: ${payload.messageId})`);
                    const callbackData = Buffer.from(payload.data, 'base64');
                    await client.invoke(new Api.messages.GetBotCallbackAnswer({
                        peer: botEntity || BOT_USERNAME,
                        msgId: payload.messageId,
                        data: callbackData
                    }));
                    console.log(`[TG] Tombol berhasil ditekan!`);
                } catch (err) {
                    console.error('[TG ERROR] Gagal menekan tombol:', err);
                }
            });
        });

    } catch (error) {
        console.error('[SYSTEM ERROR]', error);
    }
}

startSystem();
