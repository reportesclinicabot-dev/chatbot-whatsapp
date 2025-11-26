// index.js

// 1. Añade "fetchLatestBaileysVersion" a la importación
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const path = require('path');
const express = require('express');
const fs = require('fs');
const pino = require('pino');
const { handleMessage } = require('./messageHandler');
const { generateAndEmailReport } = require('./reportGenerator');
require('dotenv').config();

const authFolder = path.join(__dirname, 'auth_info_baileys');
// if (fs.existsSync(authFolder)) {
//     console.log('[Inicio] Eliminando carpeta de autenticación antigua para forzar un nuevo QR.');
//     fs.rmSync(authFolder, { recursive: true, force: true });
// }

const app = express();
const port = process.env.PORT || 3000;

app.get('/', (req, res) => {
    res.send('¡El chatbot de la clínica está vivo!');
});

// ... (El resto de tu código de Express no cambia)
app.get('/trigger-report', async (req, res) => {
    const { secret } = req.query;
    console.log(`[ULTIMATE DEBUG] Secreto Recibido (de la URL de GitHub): '${secret}'`);
    console.log(`[ULTIMATE DEBUG] Secreto Esperado (del .env de Render): '${process.env.CRON_SECRET}'`);
    if (secret !== process.env.CRON_SECRET) {
        console.log('[CRON-WEB] La comparación de secretos falló.');
        return res.status(401).send('Clave secreta no válida.');
    }
    res.status(202).send('Tarea de reporte aceptada. Se ejecutará en segundo plano.');
    console.log('✅ [CRON-WEB] ¡La comparación de secretos fue exitosa!');
    try {
        const fechaString = getReportDateString();
        console.log(`[CRON-WEB] Calculada fecha para el reporte: ${fechaString}`);
        await generateAndEmailReport(fechaString);
        console.log('✅ [CRON-WEB] Tarea de reporte finalizada exitosamente.');
    } catch (error) {
        console.error('❌ [CRON-WEB] Ocurrió un error crítico durante la ejecución:', error);
    }
});

app.listen(port, () => {
    console.log(`Servidor web escuchando en el puerto ${port}.`);
});

function getReportDateString() {
    const ahora = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Caracas" }));
    const diaDeLaSemana = ahora.getDay();
    let fechaDelReporte = new Date(ahora);
    if (diaDeLaSemana === 1) {
        fechaDelReporte.setDate(ahora.getDate() - 3);
    } else {
        fechaDelReporte.setDate(ahora.getDate() - 1);
    }
    return fechaDelReporte.toLocaleDateString('en-CA');
}

async function connectToWhatsApp() {
    try {
        const { state, saveCreds } = await useMultiFileAuthState(path.resolve(__dirname, 'auth_info_baileys'));

        // 2. Llama a la función para obtener la versión más reciente
        const { version, isLatest } = await fetchLatestBaileysVersion();
        console.log(`[Inicio] Usando la versión de Baileys: ${version.join('.')}, ¿Es la más reciente?: ${isLatest}`);

        const sock = makeWASocket({
            // 3. Pasa la versión obtenida a la configuración
            version,
            logger: pino({ level: 'error' }), // Cambiado a error para reducir ruido, usar trace solo si es necesario
            browser: ["Ubuntu", "Chrome", "20.0.04"],
            auth: state,
            markOnlineOnConnect: true,
            defaultQueryTimeoutMs: undefined
        });

        sock.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect, qr } = update;
            if (qr) {
                const encodedQr = encodeURIComponent(qr);
                const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodedQr}`;
                console.log('------------------------------------------------');
                console.log('¡Nuevo código QR! Abre este enlace en tu navegador:');
                console.log(qrUrl);
                console.log('------------------------------------------------');
            }
            if (connection === 'close') {
                const shouldReconnect = (lastDisconnect.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
                console.log('Conexión cerrada, reconectando...', shouldReconnect);
                if (shouldReconnect) {
                    connectToWhatsApp();
                }
            } else if (connection === 'open') {
                console.log('¡Conexión abierta y exitosa!');
            }
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('messages.upsert', async (m) => {
            const msg = m.messages[0];
            if (!msg.message || msg.key.fromMe) return;
            const from = msg.key.remoteJid;
            if (from === 'status@broadcast' || from.endsWith('@g.us')) return;
            try {
                await handleMessage(sock, msg);
            } catch (error) {
                console.error(`Error fatal al manejar un mensaje de ${from}:`, error);
            }
        });
    } catch (error) {
        console.error("Error crítico en la función connectToWhatsApp:", error);
        setTimeout(connectToWhatsApp, 15000);
    }
}

console.log('El bot está listo. El reporte automático se activará mediante un cron job web externo.');
connectToWhatsApp();