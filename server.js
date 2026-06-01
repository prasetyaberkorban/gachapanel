const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { NewMessage } = require('telegram/events');
const mongoose = require('mongoose');

// Konfigurasi Environment Variables
const API_ID = parseInt(process.env.TELEGRAM_API_ID) || 31303511; 
const API_HASH = process.env.TELEGRAM_API_HASH || '59e239139ac6905f936c87d85f55d550'; 
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://foerta:SabrinaZD@foerta.bdkirjs.mongodb.net/?appName=foerta';
const PORT = process.env.PORT || 3000;
const ENV_SESSION = process.env.TELEGRAM_SESSION || "";

// SEMUA TARGET BOT (Bot Utama & Bot Sell)
const TARGET_BOTS = [
    '@PBDxbot', '@ROCKETOTP_BOT', '@mrotpgen3_bot', '@IMS_OTP_Number_BOT', 
    '@KING_SMS_PANEL_BOT', '@OneSmsXbot', '@NokosxBot',
    '@ALL_WS_Sell_BOT', '@Ws_Sell_World_bot', '@Sellws_bot', '@wsotp200bot'
]; 

// Grouping Khusus Bot Sell untuk Fitur Reply OTP Input
const SELL_BOTS = ['@ALL_WS_Sell_BOT', '@Ws_Sell_World_bot', '@Sellws_bot', '@wsotp200bot'];

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

// State Timer Persisten di Server (1 Menit 30 Detik = 90 Detik)
let timerState = { active: false, endTime: null, timeLeft: 90 };
let timerIntervalId = null;

const SessionSchema = new mongoose.Schema({
    sessionKey: { type: String, default: 'telegram_userbot' },
    sessionString: String
});
const SessionModel = mongoose.model('TelegramSession', SessionSchema);

async function startSystem() {
    server.listen(PORT, () => console.log(`[SERVER] Berjalan di port ${PORT}`));

    try {
        await mongoose.connect(MONGODB_URI);
        let savedSession = await SessionModel.findOne({ sessionKey: 'telegram_userbot' });
        let sessionString = savedSession ? savedSession.sessionString : ENV_SESSION;

        if (!sessionString) return console.error('[TG ERROR] String Session kosong!');

        const client = new TelegramClient(new StringSession(sessionString), API_ID, API_HASH, { connectionRetries: 5 });
        await client.connect(); 
        console.log('[TG] Userbot Connected!');

        if (!savedSession && ENV_SESSION) {
            await SessionModel.create({ sessionKey: 'telegram_userbot', sessionString: ENV_SESSION });
        }

        let botEntities = {};
        for (let b of TARGET_BOTS) {
            try {
                let entity = await client.getEntity(b);
                botEntities[entity.id.toString()] = { username: b, entity: entity };
            } catch (e) {}
        }

        const parseMessageData = (msg) => {
            let buttonsArr = [];
            if (msg.replyMarkup && msg.replyMarkup.rows) {
                msg.replyMarkup.rows.forEach(row => {
                    let rowButtons = [];
                    row.buttons.forEach(btn => {
                        rowButtons.push({
                            text: btn.text,
                            data: btn.data ? btn.data.toString('base64') : null, 
                            url: btn.url || null,
                            copyText: btn.copyText || null, 
                            className: btn.className 
                        });
                    });
                    buttonsArr.push(rowButtons);
                });
            }

            // Dapatkan username bot pengirim asal untuk mencocokkan tipe bot sell
            let peerIdStr = msg.peerId && msg.peerId.userId ? msg.peerId.userId.toString() : "";
            let botUsername = botEntities[peerIdStr] ? botEntities[peerIdStr].username : "";

            return {
                messageId: msg.id,
                text: msg.message || msg.text || "",
                buttons: buttonsArr,
                isMe: msg.out,
                timestamp: msg.date ? msg.date * 1000 : Date.now(), // Ambil data epoch konversi ke ms
                isSellBot: SELL_BOTS.includes(botUsername)
            };
        };

        // EVENT: Pesan Baru
        client.addEventHandler(async (event) => {
            const msg = event.message;
            if (!msg || !msg.peerId || !msg.peerId.userId) return;
            let senderId = msg.peerId.userId.toString();
            if (botEntities[senderId]) {
                const parsed = parseMessageData(msg);
                parsed.bot = botEntities[senderId].username;
                io.emit('tg_message_update', parsed);
            }
        }, new NewMessage({ incoming: true, outgoing: true }));

        // EVENT: Pesan Di-Edit
        client.addEventHandler(async (update) => {
            let updatesToProcess = update.updates ? update.updates : [update];
            for (const u of updatesToProcess) {
                if (u.className === 'UpdateEditMessage' || u.className === 'UpdateEditChannelMessage') {
                    const msg = u.message;
                    if (!msg) continue;
                    let senderId = msg.peerId && msg.peerId.userId ? msg.peerId.userId.toString() : "";
                    if (!senderId && msg.peerId && msg.peerId.className === 'PeerUser') senderId = msg.peerId.userId.toString();

                    if (senderId && botEntities[senderId]) {
                        const parsed = parseMessageData(msg);
                        parsed.bot = botEntities[senderId].username;
                        io.emit('tg_message_update', parsed);
                    }
                }
            }
        });

        // --- MANAJEMEN SERVER-SIDE TIMER ---
        function runServerTimer() {
            if (timerIntervalId) clearInterval(timerIntervalId);
            timerIntervalId = setInterval(() => {
                if (!timerState.active) {
                    clearInterval(timerIntervalId);
                    return;
                }
                const msLeft = timerState.endTime - Date.now();
                if (msLeft <= 0) {
                    timerState.active = false;
                    timerState.timeLeft = 0;
                    io.emit('timer_update', { active: false, timeLeft: 0, status: 'timeout' });
                    clearInterval(timerIntervalId);
                } else {
                    timerState.timeLeft = Math.ceil(msLeft / 1000);
                    io.emit('timer_update', { active: true, timeLeft: timerState.timeLeft, status: 'running' });
                }
            }, 1000);
        }

        // SOCKET COMMUNICATION
        io.on('connection', (socket) => {
            // Sinkronisasi status timer saat user baru membuka web
            socket.emit('timer_update', timerState.active ? { active: true, timeLeft: timerState.timeLeft, status: 'running' } : { active: false, timeLeft: 90, status: 'idle' });

            socket.on('fetch_tg_history', async (botUsername) => {
                try {
                    const history = await client.getMessages(botUsername, { limit: 15 });
                    let parsedHistory = history.reverse().map(msg => {
                        let data = parseMessageData(msg);
                        data.bot = botUsername;
                        return data;
                    });
                    socket.emit('tg_history', { bot: botUsername, messages: parsedHistory });
                } catch (e) {}
            });

            socket.on('send_tg_command', async (payload) => {
                try { await client.sendMessage(payload.target, { message: payload.command }); } catch (err) {}
            });

            // FITUR REPLAY KODE OTP SPESIFIK
            socket.on('send_tg_reply', async (payload) => {
                try {
                    await client.sendMessage(payload.target, { 
                        message: payload.text, 
                        replyTo: payload.replyToMsgId 
                    });
                } catch (err) {}
            });

            socket.on('click_tg_inline', async (payload) => {
                try {
                    const callbackData = Buffer.from(payload.data, 'base64');
                    await client.invoke(new Api.messages.GetBotCallbackAnswer({
                        peer: payload.target,
                        msgId: payload.messageId,
                        data: callbackData
                    }));
                } catch (err) {}
            });

            socket.on('delete_tg_message', async (payload) => {
                try { await client.deleteMessages(payload.target, [payload.messageId], { revoke: true }); } catch (err) {}
            });

            // KONTROL TIMER DARI FRONTEND
            socket.on('start_server_timer', () => {
                timerState.active = true;
                timerState.endTime = Date.now() + 90000; // 1 Menit 30 Detik
                timerState.timeLeft = 90;
                io.emit('timer_update', { active: true, timeLeft: 90, status: 'running' });
                runServerTimer();
            });

            socket.on('stop_server_timer', () => {
                timerState.active = false;
                timerState.timeLeft = 90;
                if (timerIntervalId) clearInterval(timerIntervalId);
                io.emit('timer_update', { active: false, timeLeft: 90, status: 'idle' });
            });
        });

    } catch (error) { console.error('[SYSTEM ERROR]', error); }
}

startSystem();
