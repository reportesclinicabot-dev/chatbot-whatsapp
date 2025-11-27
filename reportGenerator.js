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
        { header: 'Fecha Asignada', key: 'fecha_solicitud', width: 15 },
        { header: 'Hora Registro', key: 'hora_solicitud', width: 15 },
    ];
    // FILTRO IMPORTANTE:
    // Traemos todo lo que sea 'consulta' PERO que el turno NO sea 'EMERGENCIA'
    const consultasData = datos.filter(d => d.tipo_solicitud === 'consulta' && d.numero_turno !== 'EMERGENCIA');
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
        { header: 'Fecha Asignada', key: 'fecha_solicitud', width: 15 },
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
        { header: 'Fecha Asignada', key: 'fecha_solicitud', width: 15 },
        { header: 'Hora Registro', key: 'hora_solicitud', width: 15 },
    ];
    const reembolsosData = datos.filter(d => d.tipo_solicitud === 'reembolso');
    reembolsosSheet.addRows(reembolsosData);

    // 4. Hoja de Emergencias
    const emergenciasSheet = workbook.addWorksheet('Emergencias');
    emergenciasSheet.columns = [
        { header: 'Fecha Registro', key: 'fecha_solicitud', width: 15 },
        { header: 'Hora Registro', key: 'hora_solicitud', width: 15 },
        { header: 'Tipo', key: 'tipo_consulta_detalle', width: 30 }, 
    ];
    // FILTRO IMPORTANTE:
    // Capturamos las emergencias usando la marca que pusimos en numero_turno
    const emergenciasData = datos.filter(d => d.numero_turno === 'EMERGENCIA');
    emergenciasSheet.addRows(emergenciasData);

    const filePath = path.join(__dirname, `Reporte_${fechaString}.xlsx`);
    await workbook.xlsx.writeFile(filePath);
    return filePath;
}

async function sendEmailWithAttachment(filePath, asunto) {
    if (!process.env.RESEND_API_KEY || !process.env.REPORT_EMAIL_TO) {
        console.log("❌ [EMAIL] Faltan credenciales en .env");
        return;
    }

    try {
        const fileContent = fs.readFileSync(filePath);
        await resend.emails.send({
            from: "Asistente Virtual <onboarding@resend.dev>",
            to: process.env.REPORT_EMAIL_TO,
            subject: asunto,
            html: '<p>Adjunto encontrarás el reporte generado.</p>',
            attachments: [{
                filename: path.basename(filePath),
                content: fileContent,
            }],
        });
        console.log('✅ [EMAIL] Correo enviado.');
    } catch (error) {
        console.error('❌ [EMAIL ERROR]', error);
    }
}

async function generateAndEmailReport(fechaString) {
    console.log(`[AUTO] Reporte automático: ${fechaString}`);
    try {
        const datos = await getDatosReporteDiario(fechaString);
        if (datos.length === 0) return console.log("[AUTO] Sin datos.");
        
        const filePath = await createExcelReport(datos, fechaString);
        await sendEmailWithAttachment(filePath, `Reporte Automático - ${fechaString}`);
        fs.unlinkSync(filePath);
    } catch (error) {
        console.error('[AUTO] Error:', error);
    }
}

async function generateAndSendReports(sock, recipientJid, fechaString) {
    console.log(`[MANUAL] Reporte diario: ${fechaString}`);
    try {
        const datos = await getDatosReporteDiario(fechaString);
        if (datos.length === 0) return await sock.sendMessage(recipientJid, { text: `📅 Sin registros para ${fechaString}.` });

        const filePath = await createExcelReport(datos, fechaString);

        await sock.sendMessage(recipientJid, {
            document: { url: filePath },
            mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            fileName: path.basename(filePath),
            caption: `📊 Reporte Diario (${fechaString})`
        });

        await sendEmailWithAttachment(filePath, `Reporte Diario - ${fechaString}`);
        fs.unlinkSync(filePath);
    } catch (error) {
        console.error('[MANUAL] Error:', error);
        await sock.sendMessage(recipientJid, { text: "Error generando reporte." });
    }
}

async function generateAndSendMonthlyReport(sock, recipientJid, monthYearString) {
    console.log(`[MANUAL] Reporte mensual: ${monthYearString}`);
    try {
        const datosMensuales = await getDatosReporteMensual(monthYearString);
        if (datosMensuales.length === 0) return await sock.sendMessage(recipientJid, { text: `📅 Sin registros para ${monthYearString}.` });

        const filePath = await createExcelReport(datosMensuales, `MENSUAL_${monthYearString}`);

        await sock.sendMessage(recipientJid, {
            document: { url: filePath },
            mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            fileName: path.basename(filePath),
            caption: `📊 Reporte Mensual (${monthYearString})`
        });

        await sendEmailWithAttachment(filePath, `Reporte Mensual - ${monthYearString}`);
        fs.unlinkSync(filePath);
    } catch (error) {
        console.error('[MANUAL] Error:', error);
        await sock.sendMessage(recipientJid, { text: "Error generando reporte mensual." });
    }
}

module.exports = {
    generateAndSendReports,
    generateAndEmailReport,
    generateAndSendMonthlyReport
};
