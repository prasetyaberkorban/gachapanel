const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { NewMessage } = require('telegram/events');
const mongoose = require('mongoose');

// --- DISCORD INTEGRATION ---
const { 
    Client: DiscordClient, GatewayIntentBits, ActionRowBuilder, 
    ButtonBuilder, ButtonStyle, StringSelectMenuBuilder 
} = require('discord.js');

const DISCORD_TOKEN = process.env.DISCORD_TOKEN || "";
const DISCORD_CHANNEL_ID = process.env.DISCORD_CHANNEL_ID || "";

const discordClient = new DiscordClient({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
let activeDiscordBot = '@PBDxbot';
const discordButtonCache = new Map();
const tgToDiscordMsg = new Map();
const processedOtps = new Set();

if (DISCORD_TOKEN) discordClient.login(DISCORD_TOKEN).then(() => console.log('[DISCORD] Bot Connected!')).catch(e => console.log('[DISCORD ERROR]', e));

// --- KONFIGURASI ENVIRONMENT TELEGRAM & WEB ---
const API_ID = parseInt(process.env.TELEGRAM_API_ID) || 31303511; 
const API_HASH = process.env.TELEGRAM_API_HASH || '59e239139ac6905f936c87d85f55d550'; 
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://foerta:SabrinaZD@foerta.bdkirjs.mongodb.net/?appName=foerta';
const PORT = process.env.PORT || 3000;
const ENV_SESSION = process.env.TELEGRAM_SESSION || "";

// BOTS CONFIG
const TARGET_BOTS = [
    '@PBDxbot', '@ROCKETOTP_BOT', '@mrotpgen3_bot', '@IMS_OTP_Number_BOT', 
    '@KING_SMS_PANEL_BOT', '@OneSmsXbot', '@NokosxBot',
    '@ALL_WS_Sell_BOT', '@Ws_Sell_World_bot', '@Sellws_bot', '@wsotp200bot'
]; 
const SELL_BOTS = ['@ALL_WS_Sell_BOT', '@Ws_Sell_World_bot', '@Sellws_bot', '@wsotp200bot'];

// --- INISIALISASI ---
const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.static('public'));

let timerState = { active: false, endTime: null, timeLeft: 90 };
let timerIntervalId = null;

// --- DATABASE SCHEMAS ---
const SessionSchema = new mongoose.Schema({ sessionKey: { type: String, default: 'telegram_userbot' }, sessionString: String });
const SessionModel = mongoose.model('TelegramSession', SessionSchema);

const OtpLogSchema = new mongoose.Schema({ bot: String, text: String, dateStr: String, timestamp: { type: Date, default: Date.now } });
const OtpLogModel = mongoose.model('OtpLog', OtpLogSchema);

const OtpCounterSchema = new mongoose.Schema({ dateStr: { type: String, unique: true }, count: { type: Number, default: 0 } });
const OtpCounterModel = mongoose.model('OtpCounter', OtpCounterSchema);

function getJakartaDateStr() {
    const jktDate = new Date(new Date().toLocaleString("en-US", {timeZone: "Asia/Jakarta"}));
    return `${jktDate.getFullYear()}-${String(jktDate.getMonth() + 1).padStart(2, '0')}-${String(jktDate.getDate()).padStart(2, '0')}`;
}

async function startSystem() {
    server.listen(PORT, () => console.log(`[WEB] Server running on port ${PORT}`));

    try {
        await mongoose.connect(MONGODB_URI);
        let savedSession = await SessionModel.findOne({ sessionKey: 'telegram_userbot' });
        let sessionString = savedSession ? savedSession.sessionString : ENV_SESSION;

        if (!sessionString) return console.error('[TG ERROR] String Session Kosong!');

        const client = new TelegramClient(new StringSession(sessionString), API_ID, API_HASH, { connectionRetries: 5 });
        await client.connect(); 
        console.log('[TG] Connected successfully!');

        if (!savedSession && ENV_SESSION) await SessionModel.create({ sessionKey: 'telegram_userbot', sessionString: ENV_SESSION });

        let botEntities = {};
        for (let b of TARGET_BOTS) {
            try {
                let entity = await client.getEntity(b);
                botEntities[entity.id.toString()] = { username: b, entity: entity };
            } catch (e) {}
        }

        const checkAndSaveOtp = async (botName, text, msgId) => {
            if (processedOtps.has(msgId)) return;
            const hasOtpWord = /otp|code|kode|received|assigned/i.test(text);
            const hasExact6Digits = /\b\d{3}[-\s]?\d{3}\b/.test(text);
            
            if (hasOtpWord && hasExact6Digits) {
                processedOtps.add(msgId);
                const today = getJakartaDateStr();
                await OtpLogModel.create({ bot: botName, text: text, dateStr: today });
                const counter = await OtpCounterModel.findOneAndUpdate({ dateStr: today }, { $inc: { count: 1 } }, { upsert: true, new: true });
                io.emit('analytics_update', { dateStr: today, count: counter.count });
            }
        };

        const parseMessageData = (msg) => {
            let buttonsArr = [];
            if (msg.replyMarkup && msg.replyMarkup.rows) {
                msg.replyMarkup.rows.forEach(row => {
                    let rowButtons = [];
                    row.buttons.forEach(btn => {
                        rowButtons.push({
                            text: btn.text, data: btn.data ? btn.data.toString('base64') : null, 
                            url: btn.url || null, copyText: btn.copyText || null, className: btn.className 
                        });
                    });
                    buttonsArr.push(rowButtons);
                });
            }
            let peerIdStr = msg.peerId && msg.peerId.userId ? msg.peerId.userId.toString() : "";
            let botUsername = botEntities[peerIdStr] ? botEntities[peerIdStr].username : "";

            return {
                messageId: msg.id, text: msg.message || msg.text || "", buttons: buttonsArr,
                isMe: msg.out, timestamp: msg.date ? msg.date * 1000 : Date.now(), isSellBot: SELL_BOTS.includes(botUsername)
            };
        };

        // --- CORE BROADCASTER (TELEGRAM -> WEB & DISCORD) ---
        const broadcastMessage = async (msg, isEdit = false) => {
            let senderId = msg.peerId && msg.peerId.userId ? msg.peerId.userId.toString() : "";
            if (!senderId && msg.peerId && msg.peerId.className === 'PeerUser') senderId = msg.peerId.userId.toString();

            if (senderId && botEntities[senderId]) {
                const parsed = parseMessageData(msg);
                parsed.bot = botEntities[senderId].username;

                const hasOtpWord = /otp|code|kode|received|assigned/i.test(parsed.text);
                const hasExact6Digits = /\b\d{3}[-\s]?\d{3}\b/.test(parsed.text);
                const isOtpMessage = hasOtpWord && hasExact6Digits;

                // 1. BROADCAST KE WEB UI
                io.emit('tg_message_update', parsed);
                if (!msg.out && !isEdit && isOtpMessage) await checkAndSaveOtp(parsed.bot, parsed.text, parsed.messageId);

                // 2. BROADCAST KE DISCORD
                if (discordClient.isReady() && DISCORD_CHANNEL_ID && parsed.bot === activeDiscordBot) {
                    const channel = discordClient.channels.cache.get(DISCORD_CHANNEL_ID);
                    if (channel) {
                        
                        // FORMAT TEXT MENGGUNAKAN BLOCKQUOTE AGAR BISA DI-SELECT DI HP
                        let contentLines = parsed.text.split('\n').map(line => `> ${line}`).join('\n');
                        let contentStr = `🤖 **[${parsed.bot}]**\n${contentLines}`;
                        
                        let discordComponents = [];
                        let numButtons = [];
                        let actionButtons = [];
                        let foundNums = new Set();
                        let extraButtons = [];

                        // Pilah Tombol Bawaan Telegram
                        if (msg.replyMarkup && msg.replyMarkup.rows) {
                            msg.replyMarkup.rows.forEach(row => {
                                row.buttons.forEach(btn => {
                                    let textClean = btn.text.replace(/[\s\-\(\)]/g, '');
                                    if (/^\+?\d{8,15}$/.test(textClean) || btn.className === 'KeyboardButtonCopy') {
                                        numButtons.push(btn);
                                        foundNums.add(textClean.replace(/[^\d\+]/g, ''));
                                    } else {
                                        actionButtons.push(btn);
                                    }
                                });
                            });
                        }

                        // AUTO-EXTRACT NOMOR HP DARI TEXT JIKA TIDAK ADA TOMBOLNYA
                        const textNumbers = parsed.text.match(/\+\d{10,15}/g) || [];
                        textNumbers.forEach(n => {
                            if (!foundNums.has(n)) {
                                extraButtons.push({ text: `📱 ${n}`, id: `num_${n}`, style: ButtonStyle.Secondary });
                                foundNums.add(n);
                            }
                        });

                        // AUTO-EXTRACT KODE OTP DARI TEXT
                        const otpMatch = parsed.text.match(/\b\d{3}[-\s]?\d{3}\b/);
                        if (otpMatch && hasOtpWord) {
                            let otpClean = otpMatch[0].replace(/[-\s]/g, '');
                            extraButtons.push({ text: `🔑 ${otpClean}`, id: `otp_${otpClean}`, style: ButtonStyle.Success });
                        }

                        // ALGORITMA PACKING TOMBOL (Maks 5 kolom x 5 baris)
                        let currentRow = new ActionRowBuilder();
                        const addBtnToRow = (btnBuilder) => {
                            if (currentRow.components.length >= 5) {
                                if (discordComponents.length < 5) discordComponents.push(currentRow);
                                currentRow = new ActionRowBuilder();
                            }
                            if (discordComponents.length < 5) currentRow.addComponents(btnBuilder);
                        };

                        // 1. Masukkan Tombol Nomor Telegram (Sebagai Auto-Copy di Discord)
                        numButtons.forEach(btn => {
                            let cleanNum = btn.text.replace(/[^\d\+]/g, '');
                            if(!cleanNum) cleanNum = btn.text;
                            addBtnToRow(new ButtonBuilder().setCustomId('num_' + cleanNum.substring(0,80)).setLabel(btn.text.substring(0,80)).setStyle(ButtonStyle.Secondary));
                        });

                        // 2. Masukkan Tombol Ekstra (Nomor HP / Kode OTP hasil extract)
                        extraButtons.forEach(btn => {
                            addBtnToRow(new ButtonBuilder().setCustomId(btn.id).setLabel(btn.text).setStyle(btn.style));
                        });

                        // 3. Masukkan Tombol Aksi (Change Number, dll)
                        actionButtons.forEach(btn => {
                            let customId = Math.random().toString(36).substr(2, 9);
                            if (discordButtonCache.size > 2000) discordButtonCache.clear();

                            let btnStyle = ButtonStyle.Primary;
                            let btnTextLower = btn.text.toLowerCase();
                            if (btnTextLower.includes('change') || btnTextLower.includes('cancel') || btnTextLower.includes('reject') || btnTextLower.includes('filter')) btnStyle = ButtonStyle.Secondary;
                            if (btnTextLower.includes('get') || btnTextLower.includes('join') || btnTextLower.includes('success')) btnStyle = ButtonStyle.Success;

                            let dBtn;
                            if (btn.url) {
                                dBtn = new ButtonBuilder().setLabel(btn.text.substring(0,80)).setStyle(ButtonStyle.Link).setURL(btn.url);
                            } else if (btn.data) {
                                discordButtonCache.set(customId, { target: parsed.bot, msgId: msg.id, data: btn.data });
                                dBtn = new ButtonBuilder().setCustomId(customId).setLabel(btn.text.substring(0,80)).setStyle(btnStyle);
                            } else {
                                discordButtonCache.set(customId, { target: parsed.bot, command: btn.text });
                                dBtn = new ButtonBuilder().setCustomId(customId).setLabel(btn.text.substring(0,80)).setStyle(btnStyle);
                            }
                            addBtnToRow(dBtn);
                        });

                        // 4. Tombol Delete khusus OTP
                        if (isOtpMessage) {
                            addBtnToRow(new ButtonBuilder().setCustomId('del_' + parsed.messageId).setLabel('🗑️ Delete').setStyle(ButtonStyle.Danger));
                        }

                        if (currentRow.components.length > 0 && discordComponents.length < 5) discordComponents.push(currentRow);

                        const msgPayload = { content: contentStr.substring(0, 2000), components: discordComponents };

                        // KIRIM / UPDATE PESAN
                        if (isEdit) {
                            const oldDiscordMsg = tgToDiscordMsg.get(parsed.messageId);
                            if (isOtpMessage) {
                                // JIKA MENGANDUNG OTP, JADIKAN PESAN BARU AGAR ADA NOTIF PING DI HP
                                if (oldDiscordMsg) oldDiscordMsg.delete().catch(()=>{});
                                channel.send(msgPayload).then(m => tgToDiscordMsg.set(parsed.messageId, m)).catch(()=>{});
                            } else {
                                // EDIT BIASA (Silent Edit)
                                if (oldDiscordMsg) oldDiscordMsg.edit(msgPayload).catch(()=>{});
                                else channel.send(msgPayload).then(m => tgToDiscordMsg.set(parsed.messageId, m)).catch(()=>{});
                            }
                        } else {
                            channel.send(msgPayload).then(m => tgToDiscordMsg.set(parsed.messageId, m)).catch(()=>{});
                        }
                    }
                }
            }
        };

        client.addEventHandler(async (event) => { if(event.message) await broadcastMessage(event.message, false); }, new NewMessage({ incoming: true, outgoing: true }));
        client.addEventHandler(async (update) => {
            let updatesToProcess = update.updates ? update.updates : [update];
            for (const u of updatesToProcess) {
                if ((u.className === 'UpdateEditMessage' || u.className === 'UpdateEditChannelMessage') && u.message) {
                    await broadcastMessage(u.message, true);
                }
            }
        });

        // --- DISCORD INTERACTION HANDLER (KLIK TOMBOL & MENU) ---
        discordClient.on('interactionCreate', async (interaction) => {
            
            // 1. Menu Dropdown Bot (!menu)
            if (interaction.isStringSelectMenu() && interaction.customId === 'bot_select') {
                activeDiscordBot = interaction.values[0];
                await interaction.update({ content: `✅ Panel Discord berhasil dialihkan ke **${activeDiscordBot}**`, components: [] });
                return;
            }

            if (!interaction.isButton()) return;

            // 2. Tombol Copy Nomor HP Khusus
            if (interaction.customId.startsWith('num_')) {
                const num = interaction.customId.replace('num_', '');
                return interaction.reply({ content: num, ephemeral: true });
            }

            // 3. Tombol Copy OTP Khusus
            if (interaction.customId.startsWith('otp_')) {
                const otp = interaction.customId.replace('otp_', '');
                return interaction.reply({ content: otp, ephemeral: true });
            }

            // 4. Tombol Delete Pesan OTP
            if (interaction.customId.startsWith('del_')) {
                const tgMsgId = parseInt(interaction.customId.split('_')[1]);
                try {
                    await interaction.deferUpdate(); // SILENT ACTION (tanpa notif loading)
                    await interaction.message.delete();
                    await client.deleteMessages(activeDiscordBot, [tgMsgId], { revoke: true });
                } catch(e) {}
                return;
            }

            // 5. Tombol Aksi Normal Telegram (Change Number, Get Script, dll)
            const cacheData = discordButtonCache.get(interaction.customId);
            if (!cacheData) {
                try { await interaction.deferUpdate(); } catch(e){} // Biarkan mati diam-diam jika expired
                return;
            }

            try {
                // SILENT ACTION: Meniadakan balasan "(edited) Perintah terkirim!" 
                await interaction.deferUpdate(); 
                
                if (cacheData.data) {
                    await client.invoke(new Api.messages.GetBotCallbackAnswer({ peer: cacheData.target, msgId: cacheData.msgId, data: cacheData.data }));
                } else if (cacheData.command) {
                    await client.sendMessage(cacheData.target, { message: cacheData.command });
                }
            } catch (err) {}
        });

        // --- DISCORD CHAT LISTENER ---
        discordClient.on('messageCreate', async (msg) => {
            if (msg.author.bot || msg.channelId !== DISCORD_CHANNEL_ID) return;

            // Perintah memunculkan dropdown Menu Bot
            if (msg.content === '!menu' || msg.content === '/menu' || msg.content === '!panel') {
                const selectMenu = new StringSelectMenuBuilder()
                    .setCustomId('bot_select')
                    .setPlaceholder('Pilih Bot yang ingin dikontrol...')
                    .addOptions(TARGET_BOTS.map(b => ({ label: b, value: b })));
                
                const row = new ActionRowBuilder().addComponents(selectMenu);
                return msg.reply({ content: '🎛️ **FOERTA Discord Controller**\nPilih bot di bawah ini untuk mengalihkan sinyal:', components: [row] });
            }

            // Teruskan teks manual biasa ke Telegram
            try { await client.sendMessage(activeDiscordBot, { message: msg.content }); } catch(e) {}
        });

        // --- SERVER TIMER ---
        function runServerTimer() {
            if (timerIntervalId) clearInterval(timerIntervalId);
            timerIntervalId = setInterval(() => {
                if (!timerState.active) return clearInterval(timerIntervalId);
                const msLeft = timerState.endTime - Date.now();
                if (msLeft <= 0) {
                    timerState.active = false; timerState.timeLeft = 0;
                    io.emit('timer_update', { active: false, timeLeft: 0, status: 'timeout' });
                    clearInterval(timerIntervalId);
                } else {
                    timerState.timeLeft = Math.ceil(msLeft / 1000);
                    io.emit('timer_update', { active: true, timeLeft: timerState.timeLeft, status: 'running' });
                }
            }, 1000);
        }

        io.on('connection', async (socket) => {
            socket.emit('timer_update', timerState.active ? { active: true, timeLeft: timerState.timeLeft, status: 'running' } : { active: false, timeLeft: 90, status: 'idle' });

            const todayStr = getJakartaDateStr();
            const currentCounter = await OtpCounterModel.findOne({ dateStr: todayStr });
            socket.emit('analytics_init', { dateStr: todayStr, count: currentCounter ? currentCounter.count : 0 });

            socket.on('fetch_tg_history', async (botUsername) => {
                try {
                    const history = await client.getMessages(botUsername, { limit: 15 });
                    let parsedHistory = history.reverse().map(msg => { let data = parseMessageData(msg); data.bot = botUsername; return data; });
                    socket.emit('tg_history', { bot: botUsername, messages: parsedHistory });
                } catch (e) { socket.emit('tg_history', { bot: botUsername, messages: [] }); }
            });

            socket.on('fetch_otp_logs', async () => {
                try {
                    const logs = await OtpLogModel.find().sort({ timestamp: -1 }).limit(50);
                    socket.emit('otp_logs_response', logs);
                } catch (e) {}
            });

            socket.on('reset_today_counter', async () => {
                const today = getJakartaDateStr();
                await OtpCounterModel.findOneAndUpdate({ dateStr: today }, { $set: { count: 0 } }, { upsert: true });
                io.emit('analytics_update', { dateStr: today, count: 0 });
            });

            socket.on('send_tg_command', async (payload) => { try { await client.sendMessage(payload.target, { message: payload.command }); } catch (err) {} });
            socket.on('send_tg_reply', async (payload) => { try { await client.sendMessage(payload.target, { message: payload.text, replyTo: payload.replyToMsgId }); } catch (err) {} });
            
            socket.on('click_tg_inline', async (payload) => {
                try {
                    const callbackData = Buffer.from(payload.data, 'base64');
                    await client.invoke(new Api.messages.GetBotCallbackAnswer({ peer: payload.target, msgId: payload.messageId, data: callbackData }));
                } catch (err) {}
            });
            
            socket.on('delete_tg_message', async (payload) => { try { await client.deleteMessages(payload.target, [payload.messageId], { revoke: true }); } catch (err) {} });

            socket.on('start_server_timer', () => {
                timerState.active = true; timerState.endTime = Date.now() + 90000; timerState.timeLeft = 90;
                io.emit('timer_update', { active: true, timeLeft: 90, status: 'running' });
                runServerTimer();
            });

            socket.on('stop_server_timer', () => {
                timerState.active = false; timerState.timeLeft = 90;
                if (timerIntervalId) clearInterval(timerIntervalId);
                io.emit('timer_update', { active: false, timeLeft: 90, status: 'idle' });
            });
        });

    } catch (error) { console.error('[SYSTEM ERROR]', error); }
}

startSystem();
