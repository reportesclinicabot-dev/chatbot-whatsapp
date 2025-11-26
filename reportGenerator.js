// reportGenerator.js

const ExcelJS = require('exceljs');
const { Resend } = require('resend');
const path = require('path');
const fs = require('fs');
const { getDatosReporteDiario, getDatosReporteMensual } = require('./database');
require('dotenv').config();

const resend = new Resend(process.env.RESEND_API_KEY);

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
    // Filtramos solo consultas que NO sean ECOR
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

    // 3. Hoja de Reembolsos (Sin Nómina ni Gerencia)
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

    // 4. Hoja de Emergencias (Nueva)
    const emergenciasSheet = workbook.addWorksheet('Emergencias');
    emergenciasSheet.columns = [
        { header: 'Fecha', key: 'fecha_solicitud', width: 15 },
        { header: 'Hora', key: 'hora_solicitud', width: 15 },
        { header: 'Mensaje', key: 'mensaje', width: 50 }, // Si guardamos algún mensaje
    ];
    const emergenciasData = datos.filter(d => d.tipo_solicitud === 'emergencia');
    emergenciasSheet.addRows(emergenciasData);

    const filePath = path.join(__dirname, `Reporte_Diario_${fechaString}.xlsx`);
    await workbook.xlsx.writeFile(filePath);
    return filePath;
}

async function sendEmailWithAttachment(filePath, fechaDisplay) {
    // ... (Esta función no cambia)
    try {
        console.log(`[Resend] Leyendo el archivo para adjuntar: ${filePath}`);
        const fileContent = fs.readFileSync(filePath);

        await resend.emails.send({
            from: `"Asistente Virtual Clínica" <onboarding@resend.dev>`,
            to: process.env.REPORT_EMAIL_TO,
            subject: `Reporte Diario de Solicitudes - ${fechaDisplay.toLocaleDateString('es-VE')}`,
            text: 'Adjunto se encuentra el reporte diario de consultas y reembolsos generado por el asistente virtual.',
            attachments: [{
                filename: path.basename(filePath),
                content: fileContent,
            }],
        });

        console.log('Correo con reporte enviado exitosamente a través de Resend.');
    } catch (error) {
        console.error('[Resend] Error al enviar el correo:', error.response ? error.response.data : error.message);
        throw error;
    }
}

// --- ¡FUNCIÓN MODIFICADA CON MÁS LOGS! ---
async function generateAndEmailReport(fechaString) {
    const fechaDisplay = new Date(fechaString + 'T12:00:00Z');

    // Log #1: Confirmar el inicio y la fecha que se usará.
    console.log(`[DEBUG] Iniciando generateAndEmailReport para la fecha: ${fechaString}`);

    try {
        const datos = await getDatosReporteDiario(fechaString);

        // Log #2: Ver cuántos registros se encontraron.
        console.log(`[DEBUG] Se encontraron ${datos.length} registros en la base de datos.`);

        // Log #3: Si hay datos, los mostramos para ver qué son.
        if (datos.length > 0) {
            console.log('[DEBUG] Contenido de los datos encontrados:', JSON.stringify(datos, null, 2));
        }

        // Esta es la condición que estamos investigando.
        if (datos.length === 0) {
            console.log(`[DEBUG] La condición (datos.length === 0) es verdadera. No se enviará correo.`);
            return;
        }

        console.log(`[DEBUG] La condición (datos.length === 0) es falsa. Procediendo a crear y enviar el reporte.`);

        const filePath = await createExcelReport(datos, fechaString);
        await sendEmailWithAttachment(filePath, fechaDisplay);

        fs.unlinkSync(filePath);
        console.log('[DEBUG] Reporte por correo enviado y archivo local eliminado.');

    } catch (error) {
        console.error('[DEBUG] Error crítico al generar o enviar el reporte por correo:', error);
    }
}


// --- La función generateAndSendReports para el comando manual no cambia ---
async function generateAndSendReports(sock, recipientJid, fechaString) {
    // ... (Sin cambios aquí)
    const fechaDisplay = new Date(fechaString + 'T12:00:00Z');
    console.log(`[COMANDO MANUAL] Iniciando generación de reporte para la fecha: ${fechaString}`);

    try {
        const datos = await getDatosReporteDiario(fechaString);

        if (datos.length === 0) {
            console.log(`[COMANDO MANUAL] No se encontraron datos para el reporte de ${fechaString}.`);
            await sock.sendMessage(recipientJid, { text: `Reporte del día ${fechaDisplay.toLocaleDateString('es-VE')}: No se registraron solicitudes.` });
            return;
        }

        const filePath = await createExcelReport(datos, fechaString);

        await sock.sendMessage(recipientJid, {
            document: { url: filePath },
            mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            fileName: path.basename(filePath),
            caption: `Reporte de solicitudes para el día ${fechaDisplay.toLocaleDateString('es-VE')}.`
        });
        console.log('[COMANDO MANUAL] Reporte enviado por WhatsApp.');

        await sendEmailWithAttachment(filePath, fechaDisplay);

        fs.unlinkSync(filePath);
        console.log('[COMANDO MANUAL] Archivo de reporte local eliminado.');

    } catch (error) {
        console.error('[COMANDO MANUAL] Error al generar o enviar el reporte:', error);
        await sock.sendMessage(recipientJid, { text: `⚠️ *Error Crítico* ⚠️\nNo se pudo generar el reporte.\nError: ${error.message}` });
    }
}

// Nueva función para generar y enviar reporte mensual
async function generateAndSendMonthlyReport(sock, recipientJid, monthYearString) {
    console.log(`[COMANDO MANUAL] Iniciando generación de reporte mensual para: ${monthYearString}`);
    try {
        const datosMensuales = await getDatosReporteMensual(monthYearString);

        if (datosMensuales.length === 0) {
            console.log(`[COMANDO MANUAL] No se encontraron datos para el reporte mensual de ${monthYearString}.`);
            await sock.sendMessage(recipientJid, { text: `Reporte mensual de ${monthYearString}: No se registraron solicitudes.` });
            return;
        }

        const filePath = await createExcelReport(datosMensuales, `MENSUAL_${monthYearString}`);

        await sock.sendMessage(recipientJid, {
            document: { url: filePath },
            mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            fileName: path.basename(filePath),
            caption: `Reporte mensual de solicitudes para ${monthYearString}.`
        });
        console.log('[COMANDO MANUAL] Reporte mensual enviado por WhatsApp.');

        // Opcional: Enviar por correo también si se desea
        // await sendEmailWithAttachment(filePath, new Date()); 

        fs.unlinkSync(filePath);
        console.log('[COMANDO MANUAL] Archivo de reporte mensual eliminado.');

    } catch (error) {
        console.error('[COMANDO MANUAL] Error al generar o enviar el reporte mensual:', error);
        await sock.sendMessage(recipientJid, { text: `⚠️ *Error Crítico* ⚠️\nNo se pudo generar el reporte mensual.\nError: ${error.message}` });
    }
}


module.exports = {
    generateAndSendReports,
    generateAndEmailReport,
    generateAndSendMonthlyReport
};
