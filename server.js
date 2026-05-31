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

// DAFTAR BOT YANG DIDUKUNG (DIPERBARUI)
const TARGET_BOTS = [
    '@PBDxbot', 
    '@ROCKETOTP_BOT', 
    '@mrotpgen3_bot', 
    '@IMS_OTP_Number_BOT', 
    '@KING_SMS_PANEL_BOT', 
    '@OneSmsXbot', 
    '@NokosxBot'
]; 

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
        
        let savedSession = await SessionModel.findOne({ sessionKey: 'telegram_userbot' });
        let sessionString = savedSession ? savedSession.sessionString : ENV_SESSION;

        if (!sessionString) return console.error('[TG ERROR] String Session tidak ditemukan!');

        const client = new TelegramClient(new StringSession(sessionString), API_ID, API_HASH, { connectionRetries: 5 });

        await client.connect(); 
        console.log('[TG] Connected to Telegram!');

        if (!savedSession && ENV_SESSION) {
            await SessionModel.create({ sessionKey: 'telegram_userbot', sessionString: ENV_SESSION });
        }

        // Cache ID Bot
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
            return {
                messageId: msg.id,
                text: msg.message || msg.text || "",
                buttons: buttonsArr,
                isMe: msg.out 
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
            let updatesToProcess = [];
            if (update.updates) updatesToProcess = update.updates;
            else if (update.className) updatesToProcess = [update];

            for (const u of updatesToProcess) {
                if (u.className === 'UpdateEditMessage' || u.className === 'UpdateEditChannelMessage') {
                    const msg = u.message;
                    if (!msg) continue;
                    
                    let senderId = "";
                    if (msg.peerId && msg.peerId.userId) {
                        senderId = msg.peerId.userId.toString();
                    } else if (msg.peerId && msg.peerId.className === 'PeerUser') {
                        senderId = msg.peerId.userId.toString();
                    }

                    if (senderId && botEntities[senderId]) {
                        const parsed = parseMessageData(msg);
                        parsed.bot = botEntities[senderId].username;
                        io.emit('tg_message_update', parsed);
                    }
                }
            }
        });

        // SOCKET WEB
        io.on('connection', (socket) => {
            socket.on('fetch_tg_history', async (botUsername) => {
                try {
                    const history = await client.getMessages(botUsername, { limit: 15 });
                    let parsedHistory = history.reverse().map(msg => parseMessageData(msg));
                    socket.emit('tg_history', { bot: botUsername, messages: parsedHistory });
                } catch (e) {}
            });

            socket.on('send_tg_command', async (payload) => {
                try { await client.sendMessage(payload.target, { message: payload.command }); } catch (err) {}
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
        });

    } catch (error) { console.error('[SYSTEM ERROR]', error); }
}

startSystem();
