const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const mongoose = require('mongoose');
const input = require('input');

// Konfigurasi Environment Variables (Siap untuk Heroku)
const API_ID = parseInt(process.env.TELEGRAM_API_ID) || 1234567; // Ganti jika run di lokal
const API_HASH = process.env.TELEGRAM_API_HASH || 'YOUR_API_HASH'; // Ganti jika run di lokal
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://foerta:SabrinaZD@foerta.bdkirjs.mongodb.net/?appName=foerta';
const PORT = process.env.PORT || 3000;

// Konfigurasi Target Telegram
const BOT_USERNAME = '@PBDxbot';
const OTP_GROUP_ID = -2638899812; // WAJIB GANTI DENGAN ID GRUP ASLI DARI HASIL CARA SEBELUMNYA

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

let activeNumber = "";

// Skema Database MongoDB
const SessionSchema = new mongoose.Schema({
    sessionKey: { type: String, default: 'telegram_userbot' },
    sessionString: String
});
const SessionModel = mongoose.model('TelegramSession', SessionSchema);

async function startSystem() {
    // 1. JALANKAN WEB SERVER DULUAN (Solusi Heroku R10 Boot Timeout)
    // Dengan ini, domain foerta.tech akan langsung terbuka meski bot sedang proses login
    server.listen(PORT, () => {
        console.log(`[WEB] Server web berhasil berjalan di port ${PORT}`);
    });

    try {
        // 2. KONEKSI DATABASE
        await mongoose.connect(MONGODB_URI);
        console.log('[DB] Terhubung ke MongoDB.');

        let savedSession = await SessionModel.findOne({ sessionKey: 'telegram_userbot' });
        let sessionString = savedSession ? savedSession.sessionString : "";

        // 3. INISIALISASI TELEGRAM CLIENT
        const stringSession = new StringSession(sessionString);
        const client = new TelegramClient(stringSession, API_ID, API_HASH, { connectionRetries: 5 });

        console.log('[TG] Menghubungkan ke server Telegram...');

        // Proses Login
        await client.start({
            phoneNumber: async () => await input.text('Nomor HP Telegram: '),
            password: async () => await input.text('Password (2FA): '),
            phoneCode: async () => await input.text('Kode OTP Telegram: '),
            onError: (err) => console.error('[TG ERROR]', err),
        });

        console.log('[TG] Userbot Telegram Connected!');

        // 4. SIMPAN SESI BARU JIKA BELUM ADA
        if (!savedSession) {
            const currentSessionString = client.session.save();
            await SessionModel.create({
                sessionKey: 'telegram_userbot',
                sessionString: currentSessionString
            });
            console.log('[DB] Sesi baru berhasil disimpan ke MongoDB!');
        }

        // 5. EVENT LISTENER (Membaca Pesan Telegram)
        client.addEventHandler(async (event) => {
            const message = event.message;
            if (!message) return;

            // Pastikan mengambil teks dengan aman
            const text = message.message || ""; 
            const chatIdStr = message.chatId ? message.chatId.toString() : "";

            // A. Menangkap balasan dari Bot Panel (Mendapatkan Nomor)
            // Memeriksa username bot (menghilangkan @ agar lebih aman saat pengecekan)
            if (chatIdStr === BOT_USERNAME.replace('@', '') || text.includes('WhatsApp Number Assigned')) {
                const numberMatch = text.match(/\+?\d{10,15}/);
                if (numberMatch) {
                    activeNumber = numberMatch[0];
                    console.log(`[TG] Nomor didapatkan: ${activeNumber}`);
                    io.emit('number_received', activeNumber);
                }
            }

            // B. Menangkap OTP dari Grup
            if (chatIdStr === OTP_GROUP_ID.toString() && activeNumber !== "") {
                if (text.includes(activeNumber)) {
                    // Cari format OTP (mengambil 4-6 digit angka di dekat kata 'code' atau 'otp')
                    const otpMatch = text.match(/(?:code|otp)[\s\S]*?(\d{4,6})/i);
                    if (otpMatch) {
                        const otpCode = otpMatch[1];
                        console.log(`[TG] OTP untuk ${activeNumber}: ${otpCode}`);
                        io.emit('otp_received', otpCode);
                    }
                }
            }
        });

        // 6. SOCKET.IO LISTENER (Menerima perintah dari Web)
        io.on('connection', (socket) => {
            console.log('[WEB] Client web terhubung ke dashboard.');
            
            socket.on('request_number', async () => {
                console.log('[WEB] Perintah "Get Number" ditekan dari web.');
                activeNumber = ""; // Reset nomor lama
                try {
                    await client.sendMessage(BOT_USERNAME, { message: 'Get Number' });
                } catch (err) {
                    console.error('[TG ERROR] Gagal mengirim pesan ke bot:', err);
                }
            });
        });

    } catch (error) {
        console.error('[SYSTEM FATAL ERROR] Sistem gagal dijalankan:', error);
    }
}

startSystem();
