const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');
const mongoose = require('mongoose');

// Konfigurasi Environment Variables
const API_ID = parseInt(process.env.TELEGRAM_API_ID) || 31303511; 
const API_HASH = process.env.TELEGRAM_API_HASH || '59e239139ac6905f936c87d85f55d550'; 
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://foerta:SabrinaZD@foerta.bdkirjs.mongodb.net/?appName=foerta';
const PORT = process.env.PORT || 3000;

// Sesi dari Heroku Config Vars
const ENV_SESSION = process.env.TELEGRAM_SESSION || "";

// Konfigurasi Target Telegram
const BOT_USERNAME = '@PBDxbot'; // PASTIKAN INI USERNAME ASLI BOTNYA
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
    server.listen(PORT, () => console.log(`[WEB] Server web berjalan di port ${PORT}`));

    try {
        await mongoose.connect(MONGODB_URI);
        console.log('[DB] Terhubung ke MongoDB.');

        let savedSession = await SessionModel.findOne({ sessionKey: 'telegram_userbot' });
        let sessionString = savedSession ? savedSession.sessionString : ENV_SESSION;

        if (!sessionString) {
            console.error('[TG ERROR] String Session tidak ditemukan di Heroku!');
            return;
        }

        const stringSession = new StringSession(sessionString);
        const client = new TelegramClient(stringSession, API_ID, API_HASH, { connectionRetries: 5 });

        console.log('[TG] Menghubungkan ke server Telegram...');
        await client.connect(); 
        console.log('[TG] Userbot Telegram Connected!');

        if (!savedSession && ENV_SESSION) {
            await SessionModel.create({ sessionKey: 'telegram_userbot', sessionString: ENV_SESSION });
            console.log('[DB] String Session dari Heroku berhasil di-backup ke MongoDB!');
        }

        // [PERBAIKAN] Dapatkan ID numerik dari Bot secara otomatis
        let botIdStr = "";
        try {
            const botEntity = await client.getEntity(BOT_USERNAME);
            botIdStr = botEntity.id.toString();
            console.log(`[TG] Bot ${BOT_USERNAME} berhasil diidentifikasi dengan ID: ${botIdStr}`);
        } catch (e) {
            console.error(`[TG ERROR] Gagal mendapatkan ID bot ${BOT_USERNAME}. Pastikan username-nya benar dan akun kamu pernah nge-chat bot ini!`);
        }

        // --- LISTENER TELEGRAM ---
        client.addEventHandler(async (event) => {
            const message = event.message;
            if (!message) return;

            const text = message.message || ""; 
            
            // Ekstrak Chat ID dengan aman
            let chatIdStr = "";
            if (message.peerId) {
                if (message.peerId.userId) chatIdStr = message.peerId.userId.toString();
                else if (message.peerId.channelId) chatIdStr = "-100" + message.peerId.channelId.toString();
                else if (message.peerId.chatId) chatIdStr = "-" + message.peerId.chatId.toString();
            }

            // A. Interaksi dengan Bot Panel (FULL CONTROL)
            if (chatIdStr === botIdStr) {
                const numberMatch = text.match(/\+?\d{10,15}/);
                if (numberMatch && text.includes('WhatsApp Number Assigned')) {
                    activeNumber = numberMatch[0];
                }

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

                console.log(`[TG] Menerima balasan dari Bot. Menampilkan ke web...`);
                io.emit('bot_message', { 
                    messageId: message.id, 
                    text: text, 
                    buttons: buttonsArr,
                    activeNumber: activeNumber
                });
            }

            // B. Filter OTP dari Grup
            if (chatIdStr === OTP_GROUP_ID.toString() || chatIdStr === OTP_GROUP_ID.toString().replace('-100', '')) {
                if (activeNumber !== "" && text.includes(activeNumber)) {
                    const otpMatch = text.match(/(?:code|otp)[\s\S]*?(\d{4,6})/i);
                    if (otpMatch) {
                        io.emit('otp_received', { number: activeNumber, otp: otpMatch[1] });
                    }
                }
            }
        });

        // --- SOCKET.IO LISTENER ---
        io.on('connection', (socket) => {
            socket.on('send_command', async (command) => {
                try {
                    console.log(`[WEB] Mengirim teks ke bot: ${command}`);
                    await client.sendMessage(BOT_USERNAME, { message: command });
                } catch (err) {
                    console.error('[TG ERROR] Gagal mengirim perintah:', err);
                }
            });

            socket.on('click_inline_button', async (payload) => {
                try {
                    console.log(`[TG] Menekan tombol pada pesan ID ${payload.messageId}...`);
                    const callbackData = Buffer.from(payload.data, 'base64');
                    
                    await client.invoke(new Api.messages.GetBotCallbackAnswer({
                        peer: BOT_USERNAME,
                        msgId: payload.messageId,
                        data: callbackData
                    }));
                } catch (err) {
                    console.error('[TG ERROR] Gagal menekan tombol inline:', err);
                }
            });
        });

    } catch (error) {
        console.error('[SYSTEM ERROR]', error);
    }
}

startSystem();
