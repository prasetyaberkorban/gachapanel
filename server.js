const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const mongoose = require('mongoose');
const input = require('input');

// Konfigurasi Environment Variables (untuk Heroku)
const API_ID = parseInt(process.env.TELEGRAM_API_ID) || 1234567; 
const API_HASH = process.env.TELEGRAM_API_HASH || '59e239139ac6905f936c87d85f55d550';
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://foerta:SabrinaZD@foerta.bdkirjs.mongodb.net/?appName=foerta';
const PORT = process.env.PORT || 3000;

const BOT_USERNAME = '@PBDxbot';
const OTP_GROUP_ID = -2638899812; // Ganti dengan ID grup PBD OTP

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

let activeNumber = "";

// 1. Skema MongoDB untuk menyimpan Sesi Telegram
const SessionSchema = new mongoose.Schema({
    sessionKey: { type: String, default: 'telegram_userbot' },
    sessionString: String
});
const SessionModel = mongoose.model('TelegramSession', SessionSchema);

async function startServer() {
    try {
        // Koneksi ke MongoDB
        await mongoose.connect(MONGODB_URI);
        console.log('Terhubung ke MongoDB.');

        // Ambil sesi yang tersimpan dari database
        let savedSession = await SessionModel.findOne({ sessionKey: 'telegram_userbot' });
        let sessionString = savedSession ? savedSession.sessionString : "";

        const stringSession = new StringSession(sessionString);
        const client = new TelegramClient(stringSession, API_ID, API_HASH, { connectionRetries: 5 });

        // Mulai Telegram Client
        await client.start({
            phoneNumber: async () => await input.text('Nomor HP Telegram: '),
            password: async () => await input.text('Password (2FA): '),
            phoneCode: async () => await input.text('Kode OTP Telegram: '),
            onError: (err) => console.log(err),
        });

        console.log('Userbot Telegram Connected!');

        // Jika ini login pertama (belum ada di DB), simpan string sesinya
        if (!savedSession) {
            const currentSessionString = client.session.save();
            await SessionModel.create({
                sessionKey: 'telegram_userbot',
                sessionString: currentSessionString
            });
            console.log('Sesi baru berhasil disimpan ke MongoDB!');
        }

        // --- LISTENER TELEGRAM ---
        client.addEventHandler(async (event) => {
            const message = event.message;

            // Membaca nomor dari bot panel
            if (message.chatId == BOT_USERNAME) {
                const numberMatch = message.text.match(/\+?\d{10,15}/);
                if (numberMatch) {
                    activeNumber = numberMatch[0];
                    console.log(`Nomor didapatkan: ${activeNumber}`);
                    io.emit('number_received', activeNumber);
                }
            }

            // Membaca OTP dari grup
            if (message.chatId == OTP_GROUP_ID && activeNumber !== "") {
                if (message.text.includes(activeNumber)) {
                    const otpMatch = message.text.match(/(?:code|otp)[\s\S]*?(\d{4,6})/i);
                    if (otpMatch) {
                        const otpCode = otpMatch[1];
                        console.log(`OTP untuk ${activeNumber}: ${otpCode}`);
                        io.emit('otp_received', otpCode);
                    }
                }
            }
        });

        // --- SOCKET.IO ---
        io.on('connection', (socket) => {
            socket.on('request_number', async () => {
                activeNumber = "";
                await client.sendMessage(BOT_USERNAME, { message: 'Get Number' });
            });
        });

        server.listen(PORT, () => {
            console.log(`Server berjalan di port ${PORT}`);
        });

    } catch (error) {
        console.error('Gagal menjalankan server:', error);
    }
}

startServer();
