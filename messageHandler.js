// messageHandler.js

const { downloadMediaMessage, jidNormalizedUser } = require('@whiskeysockets/baileys');
const { getCuposDisponibles, getSiguienteNumeroTurno, crearSolicitud, checkExistingAppointment } = require('./database');
const { generateAndSendReports, generateAndSendMonthlyReport } = require('./reportGenerator');
const { transcribeAudio, processConversationWithAI } = require('./aiHandler');
require('dotenv').config();

const userState = {};

// Almacenamiento temporal de admins logueados
const activeAdmins = new Set();
const envNumber = (process.env.REPORT_WHATSAPP_NUMBER || '').replace(/[^0-9]/g, '');
if (envNumber) activeAdmins.add(envNumber);

// =================================================================================
// FUNCIONES AUXILIARES
// =================================================================================

// MODIFICADO: Ahora recibe 'textoMotivo' para guardar qué pasó
async function executeEmergencyCall(sock, from, textoMotivo) {
    const ahora = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Caracas" }));
    const fechaISO = ahora.toISOString().split('T')[0];
    const horaParaDB = ahora.toTimeString().slice(0, 8);
    
    // Generamos un sufijo único para que la DB no rechace por duplicado
    // Ejemplo de turno: EMERGENCIA-143045 (HoraMinutoSegundo)
    const sufijoUnico = horaParaDB.replace(/:/g, ''); 
    const turnoUnico = `EMERGENCIA-${sufijoUnico}`;

    // Limpiamos el texto (quitamos la palabra "emergencia" si el usuario la escribió)
    let detalle = (textoMotivo || '').replace(/emergencia/gi, '').trim();
    if (!detalle) detalle = "Contacto de Emergencia (Botón Pánico)";

    await crearSolicitud({
        tipo_solicitud: 'consulta', // Mantenemos 'consulta' para pasar la validación DB
        nombre_paciente: 'EMERGENCIA',
        apellido_paciente: 'DETECTADA',
        cedula: '00000000',
        nomina: 'N/A',
        gerencia: 'N/A',
        fecha_solicitud: fechaISO,
        hora_solicitud: horaParaDB,
        numero_turno: turnoUnico, // AHORA ES ÚNICO
        tipo_consulta_detalle: detalle // AHORA GUARDAMOS EL MOTIVO
    });

    console.log(`[DB] Emergencia registrada: ${turnoUnico} | Motivo: ${detalle}`);
    await sock.sendMessage(from, { text: "🚨 Emergencia registrada. Por favor llama al: *0265-8053063*" });
}

function getDayOfWeekAsNumber(dayString) {
    if (!dayString) return null;
    const days = {
        'domingo': 0, 'lunes': 1, 'martes': 2, 'miercoles': 3, 'miércoles': 3, 'jueves': 4, 'viernes': 5, 'sabado': 6, 'sábado': 6
    };
    return days[dayString.toLowerCase()] ?? null;
}

function getInitialSearchDate() {
    const ahora = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Caracas" }));
    let fechaBusqueda = new Date(ahora.getFullYear(), ahora.getMonth(), ahora.getDate()); 

    const diaSemana = fechaBusqueda.getDay();
    const hora = ahora.getHours();

    if (diaSemana === 6) { 
        fechaBusqueda.setDate(fechaBusqueda.getDate() + 2);
    } else if (diaSemana === 0) { 
        fechaBusqueda.setDate(fechaBusqueda.getDate() + 1);
    }
    else if (hora >= 14) {
        fechaBusqueda.setDate(fechaBusqueda.getDate() + 1);
        if (fechaBusqueda.getDay() === 6) fechaBusqueda.setDate(fechaBusqueda.getDate() + 2);
    }

    return fechaBusqueda;
}

function esSolicitudECOR(textoTipo) {
    if (!textoTipo) return false;
    const texto = textoTipo.toLowerCase();
    return texto.includes('ecor') || texto.includes('físico') || texto.includes('fisico');
}

async function findNextAvailableDate(tipo, diaDeseadoString = null, esEcor = false) {
    let searchDate = getInitialSearchDate();
    const targetDay = getDayOfWeekAsNumber(diaDeseadoString);

    if (targetDay !== null) {
        while (searchDate.getDay() !== targetDay) {
            searchDate.setDate(searchDate.getDate() + 1);
        }
    }

    for (let i = 0; i < 7; i++) {
        const currentDay = searchDate.getDay();
        if (currentDay >= 1 && currentDay <= 5) {
            const tipoBusqueda = esEcor ? 'ecor' : tipo; 
            const cupos = await getCuposDisponibles(tipoBusqueda, searchDate);
            if (cupos > 0) {
                return searchDate; 
            }
        }
        searchDate.setDate(searchDate.getDate() + 1);
    }
    return null; 
}

async function handleSchedulingRequest(sock, from, tipo, args) {
    userState[from] = { data: args }; 
    const diaDeseado = args.dia_semana_deseado;
    
    const esEcor = esSolicitudECOR(args.tipo_consulta_detalle);

    if (esEcor) {
        let fechaCita = getInitialSearchDate();
        if (diaDeseado) {
            const targetDay = getDayOfWeekAsNumber(diaDeseado);
            if (targetDay !== null) {
                while (fechaCita.getDay() !== targetDay) {
                    fechaCita.setDate(fechaCita.getDate() + 1);
                }
            }
        }
        if (fechaCita.getDay() === 0) fechaCita.setDate(fechaCita.getDate() + 1);
        if (fechaCita.getDay() === 6) fechaCita.setDate(fechaCita.getDate() + 2);

        const mensaje = await procesarCreacionSolicitud(from, 'ecor', fechaCita);
        await sock.sendMessage(from, { text: mensaje });
        return true;
    }

    const fechaCita = await findNextAvailableDate(tipo, diaDeseado);

    if (fechaCita) {
        if (tipo === 'consulta' && args.cedula) {
            const tieneCita = await checkExistingAppointment(args.cedula, fechaCita);
            if (tieneCita) {
                const fechaFormateada = fechaCita.toLocaleDateString('es-VE', { weekday: 'long', day: 'numeric', month: 'long' });
                await sock.sendMessage(from, { text: `Lo siento, ya tienes una cita registrada para el ${fechaFormateada}. No es posible agendar dos citas el mismo día.` });
                return true;
            }
        }

        const mensaje = await procesarCreacionSolicitud(from, tipo, fechaCita);
        await sock.sendMessage(from, { text: mensaje });

        userState[from] = { step: 'esperando_confirmacion_final' };
        return false; 
    } else {
        const mensajeAviso = diaDeseado
            ? `Lo sentimos, no hay cupos disponibles para el ${diaDeseado} ni en los días siguientes. Por favor, intenta para otra fecha.`
            : "Lo sentimos, no hemos encontrado cupos disponibles en los próximos 7 días. Por favor, intenta de nuevo más tarde.";
        await sock.sendMessage(from, { text: mensajeAviso });
        return true; 
    }
}

async function executeReimbursementRequest(sock, from, args) {
    return await handleSchedulingRequest(sock, from, 'reembolso', args);
}

async function executeAppointmentRequest(sock, from, args) {
    return await handleSchedulingRequest(sock, from, 'consulta', args);
}

async function procesarCreacionSolicitud(from, tipo, fecha) {
    const currentState = userState[from];
    if (!currentState || !currentState.data) return "Hubo un error al recuperar tus datos.";

    const prefijo = (tipo === 'reembolso') ? 'R' : 'C';
    let tipoSolicitudDB = tipo;
    if (tipo === 'consulta' && esSolicitudECOR(currentState.data.tipo_consulta_detalle)) {
        tipoSolicitudDB = 'ecor';
    }

    const numeroTurno = await getSiguienteNumeroTurno(prefijo, fecha);
    if (!numeroTurno) return "Hubo un error crítico al generar tu número de turno.";

    const ahora = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Caracas" }));
    const horaParaDB = ahora.toTimeString().slice(0, 8);
    const horaParaUsuario = ahora.toLocaleTimeString('es-VE', { hour: '2-digit', minute: '2-digit', hour12: true });

    const datosParaGuardar = { ...currentState.data };
    delete datosParaGuardar.fechaPropuesta;
    delete datosParaGuardar.dia_semana_deseado; 

    const solicitudData = {
        ...datosParaGuardar,
        tipo_solicitud: tipoSolicitudDB,
        numero_turno: numeroTurno,
        fecha_solicitud: fecha.toISOString().split('T')[0],
        hora_solicitud: horaParaDB
    };

    const nuevaSolicitud = await crearSolicitud(solicitudData);
    if (nuevaSolicitud) {
        const fechaFormateada = fecha.toLocaleDateString('es-VE', { weekday: 'long', day: 'numeric', month: 'long' });
        const tipoMsj = tipoSolicitudDB === 'ecor' ? 'Su examen ECOR' : 'Tu solicitud';
        return `¡Registro exitoso!\n\n${tipoMsj} ha sido agendado con el número de turno: *${numeroTurno}*.\n\n*Fecha Asignada:* ${fechaFormateada}\n*Hora del Registro:* ${horaParaUsuario}\n\n_Horario de atención: 8:00 AM a 2:00 PM._\n\n¿En qué más puedo ayudarte?`;
    }
    return "Hubo un error al registrar tu solicitud en la base de datos.";
}

async function startMenuFlow(sock, from, prependMessage = null) {
    userState[from] = { step: 'menu_principal_respuesta' };
    let menuText = (prependMessage || "¡Hola!") +
        "\n\nNuestro asistente inteligente no está disponible. Por favor, responde con el número de tu solicitud:\n\n*-1-* 🚨 Emergencia\n*-2-* 💸 Solicitar Reembolso\n*-3-* 🩺 Agendar Consulta";
    await sock.sendMessage(from, { text: menuText });
}

async function handleMenuResponse(sock, from, messageContent) {
    const currentState = userState[from];
    if (!currentState || currentState.step !== 'menu_principal_respuesta') return;
    const choice = messageContent.trim();
    if (choice === '1') {
        // Pasamos "Botón de pánico" como motivo si usan el menú
        await executeEmergencyCall(sock, from, "Botón de Pánico (Menú)");
        delete userState[from];
    } else if (choice === '2' || choice === '3') {
        const requestType = choice === '2' ? 'reembolso' : 'consulta';
        await sock.sendMessage(from, { text: `Para procesar tu *${requestType}*, por favor, indica toda la información en un solo mensaje.` });
        delete userState[from];
    } else {
        await sock.sendMessage(from, { text: "Opción no válida. Responde 1, 2 o 3." });
    }
}

// =================================================================================
// HANDLER PRINCIPAL
// =================================================================================
async function handleMessage(sock, msg) {
    const from = jidNormalizedUser(msg.key.remoteJid);
    const senderJid = msg.key.participant || msg.key.remoteJid; 
    const senderNormalized = jidNormalizedUser(senderJid);
    const senderNumber = senderNormalized.split('@')[0]; 

    const isAudio = msg.message?.audioMessage;
    let originalText = (msg.message?.conversation || msg.message?.extendedTextMessage?.text || '').trim();

    // COMANDOS ADMIN
    if (originalText.startsWith('/')) {
        const parts = originalText.split(' ');
        const command = parts[0].toLowerCase();
        
        if (command === '/login') {
            const passwordProvided = parts[1];
            if (passwordProvided === process.env.ADMIN_PASSWORD) {
                activeAdmins.add(senderNumber);
                await sock.sendMessage(from, { text: "✅ Login correcto. Eres admin." });
            } else {
                await sock.sendMessage(from, { text: "⛔ Contraseña incorrecta." });
            }
            return; 
        }

        const isAdmin = activeAdmins.has(senderNumber);

        if (command === '/reporte-mensual') {
            if (!isAdmin) return sock.sendMessage(from, { text: "🔒 Requiere /login." });
            let mesString = new Date().toISOString().slice(0, 7); 
            if (parts.length > 1 && /^\d{4}-\d{2}$/.test(parts[1])) mesString = parts[1];
            await sock.sendMessage(from, { text: `📊 Generando reporte MENSUAL (${mesString})...` });
            await generateAndSendMonthlyReport(sock, from, mesString);
            return; 
        }

        if (command === '/reporte') {
            if (!isAdmin) return sock.sendMessage(from, { text: "🔒 Requiere /login." });
            let fechaString = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Caracas' }); 
            if (parts.length > 1 && /^\d{4}-\d{2}-\d{2}$/.test(parts[1])) fechaString = parts[1];
            await sock.sendMessage(from, { text: `📈 Generando reporte DIARIO (${fechaString})...` });
            await generateAndSendReports(sock, from, fechaString);
            return; 
        }
    }

    if (originalText.toLowerCase() === 'menu') {
        delete userState[from];
        await startMenuFlow(sock, from, "Reiniciando...");
        return;
    }

    const currentState = userState[from];

    if (currentState && currentState.step === 'esperando_confirmacion_final') {
        const respuesta = originalText.toLowerCase();
        if (respuesta.includes('no') || respuesta.includes('gracias') || respuesta.includes('listo')) {
            await sock.sendMessage(from, { text: "Estamos para servirle." });
            delete userState[from];
            return;
        } else {
            delete userState[from];
        }
    }

    if (currentState && currentState.step === 'menu_principal_respuesta') {
        await handleMenuResponse(sock, from, originalText);
        return;
    }

    if (isAudio) {
        try {
            await sock.sendMessage(from, { text: "Escuchando audio..." });
            const buffer = await downloadMediaMessage(msg, 'buffer', {});
            originalText = await transcribeAudio(buffer);
            if (!originalText) {
                await sock.sendMessage(from, { text: "No entendí el audio." });
                return;
            }
        } catch (error) {
            console.error("Error audio:", error);
            return;
        }
    }

    if (!originalText) return;

    if (!userState[from] || !userState[from].history) userState[from] = { history: [] };
    userState[from].history.push({ role: 'user', content: originalText });

    try {
        const aiResponse = await processConversationWithAI(userState[from].history);

        if (!aiResponse) {
            userState[from].history.pop();
            await startMenuFlow(sock, from, "El sistema no responde.");
            return;
        }

        if (aiResponse.type === 'reply' && aiResponse.content) {
            userState[from].history.push({ role: 'assistant', content: aiResponse.content });
            await sock.sendMessage(from, { text: aiResponse.content });
        } else if (aiResponse.type === 'tool_call' && aiResponse.call?.name) {
            let taskCompleted = true;
            const toolName = aiResponse.call.name;
            const toolArgs = JSON.parse(aiResponse.call.arguments || '{}');
            
            console.log(`[TOOL] ${toolName}`, toolArgs);
            
            if (toolName === 'informar_emergencia') {
                // MODIFICADO: Pasamos el texto original para guardarlo como motivo
                await executeEmergencyCall(sock, from, originalText);
            } 
            else if (toolName === 'solicitar_reembolso') taskCompleted = await executeReimbursementRequest(sock, from, toolArgs);
            else if (toolName === 'agendar_solicitud') taskCompleted = await executeAppointmentRequest(sock, from, toolArgs);
            
            if (taskCompleted && userState[from]?.step !== 'esperando_confirmacion_final') {
                delete userState[from];
            }
        }
    } catch (error) {
        console.error("Error IA:", error);
        if (userState[from]) userState[from].history.pop();
        await startMenuFlow(sock, from, "Error técnico.");
    }
}

module.exports = { handleMessage };
