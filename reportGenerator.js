// reportGenerator.js

const ExcelJS = require('exceljs');
const { Resend } = require('resend');
const path = require('path');
const fs = require('fs');
const { getDatosReporteDiario, getDatosReporteMensual } = require('./database');
require('dotenv').config();

// Inicializamos Resend
const resend = new Resend(process.env.RESEND_API_KEY);

/**
 * Crea el archivo Excel con los datos proporcionados
 */
async function createExcelReport(datos, fechaString) {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'AsistenteVirtualClinica';
    workbook.created = new Date();

    // 1. Hoja de Consultas (General)
    const consultasSheet = workbook.addWorksheet('Consultas');
    consultasSheet.columns = [
        { header: 'Turno', key: 'numero_turno', width: 12 },
        { header: 'Nombre', key: 'nombre_paciente', width: 20 },
        { header: 'Apellido', key: 'apellido_paciente', width: 20 },
        { header: 'Cédula', key: 'cedula', width: 15 },
        { header: 'Tipo Consulta', key: 'tipo_consulta_detalle', width: 25 },
        { header: 'Nómina', key: 'nomina', width: 15 },
        { header: 'Gerencia', key: 'gerencia', width: 25 },
        { header: 'Hora Registro', key: 'hora_solicitud', width: 15 },
    ];
    const consultasData = datos.filter(d => d.tipo_solicitud === 'consulta');
    consultasSheet.addRows(consultasData);

    // 2. Hoja de ECOR
    const ecorSheet = workbook.addWorksheet('ECOR');
    ecorSheet.columns = [
        { header: 'Turno', key: 'numero_turno', width: 12 },
        { header: 'Nombre', key: 'nombre_paciente', width: 20 },
        { header: 'Apellido', key: 'apellido_paciente', width: 20 },
        { header: 'Cédula', key: 'cedula', width: 15 },
        { header: 'Nómina', key: 'nomina', width: 15 },
        { header: 'Gerencia', key: 'gerencia', width: 25 },
        { header: 'Hora Registro', key: 'hora_solicitud', width: 15 },
    ];
    const ecorData = datos.filter(d => d.tipo_solicitud === 'ecor');
    ecorSheet.addRows(ecorData);

    // 3. Hoja de Reembolsos
    const reembolsosSheet = workbook.addWorksheet('Reembolsos');
    reembolsosSheet.columns = [
        { header: 'Turno', key: 'numero_turno', width: 12 },
        { header: 'Nombre', key: 'nombre_paciente', width: 25 },
        { header: 'Apellido', key: 'apellido_paciente', width: 25 },
        { header: 'Cédula', key: 'cedula', width: 15 },
        { header: 'Hora Registro', key: 'hora_solicitud', width: 15 },
    ];
    const reembolsosData = datos.filter(d => d.tipo_solicitud === 'reembolso');
    reembolsosSheet.addRows(reembolsosData);

    // 4. Hoja de Emergencias
    const emergenciasSheet = workbook.addWorksheet('Emergencias');
    emergenciasSheet.columns = [
        { header: 'Fecha', key: 'fecha_solicitud', width: 15 },
        { header: 'Hora', key: 'hora_solicitud', width: 15 },
        { header: 'Mensaje', key: 'mensaje', width: 50 }, 
    ];
    const emergenciasData = datos.filter(d => d.tipo_solicitud === 'emergencia');
    emergenciasSheet.addRows(emergenciasData);

    const filePath = path.join(__dirname, `Reporte_${fechaString}.xlsx`);
    await workbook.xlsx.writeFile(filePath);
    return filePath;
}

/**
 * Envía el correo usando Resend
 */
async function sendEmailWithAttachment(filePath, asunto) {
    if (!process.env.RESEND_API_KEY) {
        console.log("❌ [EMAIL] No se envió el correo: Falta RESEND_API_KEY en .env");
        return;
    }
    if (!process.env.REPORT_EMAIL_TO) {
        console.log("❌ [EMAIL] No se envió el correo: Falta REPORT_EMAIL_TO en .env");
        return;
    }

    try {
        console.log(`[EMAIL] Preparando envío a: ${process.env.REPORT_EMAIL_TO}`);
        const fileContent = fs.readFileSync(filePath);

        const { data, error } = await resend.emails.send({
            from: "Asistente Virtual <onboarding@resend.dev>",
            to: process.env.REPORT_EMAIL_TO,
            subject: asunto,
            html: '<p>Adjunto encontrarás el reporte solicitado generado por el sistema.</p>',
            attachments: [{
                filename: path.basename(filePath),
                content: fileContent,
            }],
        });

        if (error) {
            console.error('❌ [EMAIL ERROR API] Resend respondió con error:', error);
            return;
        }

        console.log('✅ [EMAIL] Correo enviado exitosamente. ID:', data.id);
    } catch (error) {
        console.error('❌ [EMAIL EXCEPTION] Error inesperado al enviar correo:', error);
    }
}

// --- COMANDO AUTOMÁTICO (CRON) ---
async function generateAndEmailReport(fechaString) {
    console.log(`[AUTO] Iniciando reporte automático para: ${fechaString}`);
    try {
        const datos = await getDatosReporteDiario(fechaString);
        if (datos.length === 0) {
            console.log(`[AUTO] Sin datos para ${fechaString}. No se envía nada.`);
            return;
        }
        const filePath = await createExcelReport(datos, fechaString);
        await sendEmailWithAttachment(filePath, `Reporte Diario Automático - ${fechaString}`);
        fs.unlinkSync(filePath);
        console.log('[AUTO] Archivo eliminado tras envío.');
    } catch (error) {
        console.error('[AUTO] Error crítico:', error);
    }
}

// --- COMANDO MANUAL WHATSAPP (/reporte) ---
async function generateAndSendReports(sock, recipientJid, fechaString) {
    console.log(`[MANUAL] Reporte DIARIO para: ${fechaString}`);
    try {
        const datos = await getDatosReporteDiario(fechaString);

        if (datos.length === 0) {
            await sock.sendMessage(recipientJid, { text: `📅 Reporte del ${fechaString}: Sin registros.` });
            return;
        }

        const filePath = await createExcelReport(datos, fechaString);

        // 1. Enviar por WhatsApp
        await sock.sendMessage(recipientJid, {
            document: { url: filePath },
            mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            fileName: path.basename(filePath),
            caption: `📊 Reporte Diario (${fechaString})`
        });

        // 2. Enviar por Correo (AHORA ACTIVADO Y CON LOGS)
        await sendEmailWithAttachment(filePath, `Reporte Diario Solicitado - ${fechaString}`);

        fs.unlinkSync(filePath);
        console.log('[MANUAL] Archivo eliminado.');

    } catch (error) {
        console.error('[MANUAL] Error:', error);
        await sock.sendMessage(recipientJid, { text: `⚠️ Error al generar reporte: ${error.message}` });
    }
}

// --- COMANDO MANUAL WHATSAPP (/reporte-mensual) ---
async function generateAndSendMonthlyReport(sock, recipientJid, monthYearString) {
    console.log(`[MANUAL] Reporte MENSUAL para: ${monthYearString}`);
    try {
        const datosMensuales = await getDatosReporteMensual(monthYearString);

        if (datosMensuales.length === 0) {
            await sock.sendMessage(recipientJid, { text: `📅 Reporte Mensual (${monthYearString}): Sin registros.` });
            return;
        }

        const filePath = await createExcelReport(datosMensuales, `MENSUAL_${monthYearString}`);

        // 1. Enviar por WhatsApp
        await sock.sendMessage(recipientJid, {
            document: { url: filePath },
            mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            fileName: path.basename(filePath),
            caption: `📊 Reporte Mensual (${monthYearString})`
        });

        // 2. Enviar por Correo (¡ESTO FALTABA ANTES!)
        await sendEmailWithAttachment(filePath, `Reporte Mensual Solicitado - ${monthYearString}`);

        fs.unlinkSync(filePath);
        console.log('[MANUAL] Archivo eliminado.');

    } catch (error) {
        console.error('[MANUAL] Error:', error);
        await sock.sendMessage(recipientJid, { text: `⚠️ Error al generar reporte mensual: ${error.message}` });
    }
}

module.exports = {
    generateAndSendReports,
    generateAndEmailReport,
    generateAndSendMonthlyReport
};
