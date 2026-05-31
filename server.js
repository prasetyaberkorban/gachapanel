const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const mongoose = require('mongoose');

// Konfigurasi Environment Variables
const API_ID = parseInt(process.env.TELEGRAM_API_ID) || 31303511; // GANTI JIKA RUN LOKAL
const API_HASH = process.env.TELEGRAM_API_HASH || '59e239139ac6905f936c87d85f55d550'; // GANTI JIKA RUN LOKAL
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://foerta:SabrinaZD@foerta.bdkirjs.mongodb.net/?appName=foerta';
const PORT = process.env.PORT || 3000;

// Sesi dari Heroku Config Vars (hasil dari login.js tadi)
const ENV_SESSION = process.env.TELEGRAM_SESSION || "";

// Konfigurasi Target Telegram
const BOT_USERNAME = '@PBDxbot';
const OTP_GROUP_ID = -2638899812; // WAJIB GANTI DENGAN ID GRUP ASLI

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
    // 1. JALANKAN WEB SERVER DULUAN (Mencegah Heroku Timeout)
    server.listen(PORT, () => {
        console.log(`[WEB] Server web berhasil berjalan di port ${PORT}`);
    });

    try {
        // 2. KONEKSI DATABASE
        await mongoose.connect(MONGODB_URI);
        console.log('[DB] Terhubung ke MongoDB.');

        // 3. AMBIL SESI DARI DB ATAU DARI HEROKU CONFIG VARS
        let savedSession = await SessionModel.findOne({ sessionKey: 'telegram_userbot' });
        let sessionString = savedSession ? savedSession.sessionString : ENV_SESSION;

        if (!sessionString) {
            console.error('[TG ERROR] String Session tidak ditemukan! Pastikan TELEGRAM_SESSION sudah dipasang di Heroku.');
            return; 
        }

        // 4. INISIALISASI TELEGRAM CLIENT
        const stringSession = new StringSession(sessionString);
        const client = new TelegramClient(stringSession, API_ID, API_HASH, { connectionRetries: 5 });

        console.log('[TG] Menghubungkan ke server Telegram...');

        // Langsung connect menggunakan String Session (tanpa meminta input terminal)
        await client.connect(); 
        console.log('[TG] Userbot Telegram Connected!');

        // Backup sesi ke MongoDB jika asalnya dari Config Vars (agar tersimpan permanen)
        if (!savedSession && ENV_SESSION) {
            await SessionModel.create({
                sessionKey: 'telegram_userbot',
                sessionString: ENV_SESSION
            });
            console.log('[DB] String Session dari Heroku berhasil di-backup ke MongoDB!');
        }

        // 5. EVENT LISTENER (Membaca Pesan Telegram)
        client.addEventHandler(async (event) => {
            const message = event.message;
            if (!message) return;

            const text = message.message || ""; 
            const chatIdStr = message.chatId ? message.chatId.toString() : "";

            // A. Menangkap balasan dari Bot Panel (Mendapatkan Nomor)
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
                    // Cari format OTP 4-6 digit
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
