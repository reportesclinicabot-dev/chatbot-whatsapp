// messageHandler.js

const { downloadMediaMessage, jidNormalizedUser } = require('@whiskeysockets/baileys');
const { getCuposDisponibles, getSiguienteNumeroTurno, crearSolicitud, checkExistingAppointment } = require('./database');
const { generateAndSendReports, generateAndSendMonthlyReport } = require('./reportGenerator');
const { transcribeAudio, processConversationWithAI } = require('./aiHandler');
require('dotenv').config();

const userState = {};

/**
 * Envía un mensaje de emergencia con el número de contacto y finaliza la conversación.
 */
async function executeEmergencyCall(sock, from) {
    const ahora = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Caracas" }));
    const fechaISO = ahora.toISOString().split('T')[0];
    const horaParaDB = ahora.toTimeString().slice(0, 8);

    await crearSolicitud({
        tipo_solicitud: 'emergencia',
        fecha_solicitud: fechaISO,
        hora_solicitud: horaParaDB,
        numero_turno: 'EMERGENCIA'
    });

    await sock.sendMessage(from, { text: "Detecté una emergencia. Por favor, comunícate directamente al siguiente número:\n*0265-8053063*" });
}

// =================================================================================
// LÓGICA DE BÚSQUEDA DE FECHAS
// =================================================================================

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

async function findNextAvailableDate(tipo, diaDeseadoString = null) {
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
            const tipoBusqueda = tipo === 'ecor' ? 'consulta' : tipo;
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

    const tipoParaCupos = args.tipo_consulta_detalle === 'Examen físico anual (ECOR)' ? 'ecor' : tipo;

    if (tipoParaCupos === 'ecor') {
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
    if (!currentState || !currentState.data) return "Hubo un error al recuperar tus datos. Por favor, intenta de nuevo.";

    const prefijo = (tipo === 'reembolso') ? 'R' : 'C';
    const tipoSolicitudDB = (currentState.data.tipo_consulta_detalle === 'Examen físico anual (ECOR)') ? 'ecor' : tipo;

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
        return `¡Registro exitoso!\n\nTu solicitud ha sido agendada con el número de turno: *${numeroTurno}*.\n\n*Fecha Asignada:* ${fechaFormateada}\n*Hora del Registro:* ${horaParaUsuario}\n\n_Te recordamos que el horario de atención en la clínica es de 8:00 AM a 2:00 PM._\n\n¿En qué más puedo ayudarte?`;
    }
    return "Hubo un error al registrar tu solicitud en la base de datos.";
}

async function startMenuFlow(sock, from, prependMessage = null) {
    console.log(`Activando flujo de menú de respaldo de texto para ${from}`);
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
        await executeEmergencyCall(sock, from);
        delete userState[from];
    } else if (choice === '2' || choice === '3') {
        const requestType = choice === '2' ? 'reembolso' : 'consulta';
        await sock.sendMessage(from, { text: `Para procesar tu *${requestType}*, por favor, indica toda la información en un solo mensaje. Ejemplo:\n\nNombre: Juan Pérez\nCédula: 12345678\nNómina: Contractual Mensual\nGerencia: Operaciones\nTipo de Consulta: Reposo Médico` });
        delete userState[from];
    } else {
        await sock.sendMessage(from, { text: "Opción no válida. Por favor, responde con 1, 2 o 3." });
    }
}

// =================================================================================
// HANDLER PRINCIPAL (Lógica de Comandos y Remitente CORREGIDA)
// =================================================================================
async function handleMessage(sock, msg) {
    // 1. Identificamos el CHAT (dónde responder)
    const from = jidNormalizedUser(msg.key.remoteJid);
    
    // 2. Identificamos el USUARIO (quién escribe realmente)
    // Esto arregla el bug donde sale un número "loco" si es un grupo o dispositivo vinculado
    const senderJid = msg.key.participant || msg.key.remoteJid; 
    const senderNormalized = jidNormalizedUser(senderJid);
    const senderNumber = senderNormalized.split('@')[0]; // ESTE es el número real que escribe

    // 3. Número del admin limpio desde el .env
    const envAdminNumber = (process.env.REPORT_WHATSAPP_NUMBER || '').replace(/[^0-9]/g, '');

    console.log(`[DEBUG] Chat: ${from.split('@')[0]} | Sender Real: ${senderNumber} | Admin Config: ${envAdminNumber}`);

    const isAudio = msg.message?.audioMessage;
    let originalText = (msg.message?.conversation || msg.message?.extendedTextMessage?.text || '').trim();

    // -------------------------------------------------------------
    // BLOQUE DE COMANDOS DE ADMINISTRADOR
    // -------------------------------------------------------------
    if (originalText.startsWith('/')) {
        const command = originalText.toLowerCase().split(' ')[0];
        
        // Comparamos el número REAL del remitente con el admin
        const isAdmin = senderNumber === envAdminNumber;

        // 1. REPORTE MENSUAL: /reporte-mensual (opcional: YYYY-MM)
        if (command === '/reporte-mensual') {
            if (!isAdmin) {
                console.log(`[SEGURIDAD] Bloqueado. ${senderNumber} no es el admin.`);
                return;
            }
            const parts = originalText.split(' ');
            let mesString = new Date().toISOString().slice(0, 7); 
            if (parts.length > 1 && /^\d{4}-\d{2}$/.test(parts[1])) {
                mesString = parts[1];
            }
            
            await sock.sendMessage(from, { text: `📊 Generando reporte MENSUAL (${mesString})...` });
            await generateAndSendMonthlyReport(sock, from, mesString);
            return; 
        }

        // 2. REPORTE DIARIO: /reporte (opcional: YYYY-MM-DD)
        if (command === '/reporte') {
            if (!isAdmin) {
                console.log(`[SEGURIDAD] Bloqueado. ${senderNumber} no es el admin.`);
                return;
            }
            const parts = originalText.split(' ');
            let fechaString = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Caracas' }); 
            if (parts.length > 1 && /^\d{4}-\d{2}-\d{2}$/.test(parts[1])) {
                fechaString = parts[1];
            }

            await sock.sendMessage(from, { text: `📈 Generando reporte DIARIO (${fechaString})...` });
            await generateAndSendReports(sock, from, fechaString);
            return; 
        }
    }
    // -------------------------------------------------------------
    // FIN BLOQUE COMANDOS
    // -------------------------------------------------------------

    if (originalText.toLowerCase() === 'menu') {
        delete userState[from];
        await startMenuFlow(sock, from, "Ok, empecemos de nuevo.");
        return;
    }

    const currentState = userState[from];

    // --- MANEJADOR DE CONFIRMACIÓN FINAL ---
    if (currentState && currentState.step === 'esperando_confirmacion_final') {
        const respuesta = originalText.toLowerCase();
        if (respuesta.includes('no') || respuesta.includes('gracias') || respuesta.includes('listo')) {
            await sock.sendMessage(from, { text: "Estamos para servirle, que tenga un gran día." });
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

    // --- PROCESAMIENTO DE AUDIO ---
    if (isAudio) {
        try {
            console.log(`[AUDIO] Recibido de ${senderNumber}. Procesando...`);
            await sock.sendMessage(from, { text: "Procesando tu nota de voz, un momento..." });

            const buffer = await downloadMediaMessage(msg, 'buffer', {});
            if (!buffer || buffer.length === 0) {
                await sock.sendMessage(from, { text: "Error al descargar audio." });
                return;
            }

            originalText = await transcribeAudio(buffer);
            if (!originalText) {
                await sock.sendMessage(from, { text: "No pude entender el audio. ¿Podrías escribirlo?" });
                return;
            }
            console.log(`[TRANSCRIPCIÓN] "${originalText}"`);
        } catch (error) {
            console.error("Error en audio:", error);
            await sock.sendMessage(from, { text: "Error procesando el audio." });
            return;
        }
    }

    if (!originalText) return;

    // --- INTERACCIÓN CON IA ---
    if (!userState[from] || !userState[from].history) {
        userState[from] = { history: [] };
    }
    userState[from].history.push({ role: 'user', content: originalText });

    try {
        const aiResponse = await processConversationWithAI(userState[from].history);

        if (!aiResponse) {
            userState[from].history.pop();
            await startMenuFlow(sock, from, "Lo siento, el asistente inteligente no responde.");
            return;
        }

        if (aiResponse.type === 'reply' && aiResponse.content) {
            userState[from].history.push({ role: 'assistant', content: aiResponse.content });
            await sock.sendMessage(from, { text: aiResponse.content });
        } else if (aiResponse.type === 'tool_call' && aiResponse.call?.name) {
            let taskCompleted = true;
            const toolName = aiResponse.call.name;
            const toolArgs = JSON.parse(aiResponse.call.arguments || '{}');
            
            console.log(`[TOOL] Ejecutando: ${toolName}`, toolArgs);
            
            if (toolName === 'informar_emergencia') await executeEmergencyCall(sock, from);
            else if (toolName === 'solicitar_reembolso') taskCompleted = await executeReimbursementRequest(sock, from, toolArgs);
            else if (toolName === 'agendar_solicitud') taskCompleted = await executeAppointmentRequest(sock, from, toolArgs);
            else throw new Error(`Herramienta desconocida: ${toolName}`);

            if (taskCompleted && userState[from]?.step !== 'esperando_confirmacion_final') {
                delete userState[from];
            }
        } else {
            userState[from].history.pop();
            throw new Error(`Respuesta IA desconocida`);
        }
    } catch (error) {
        console.error("Error IA:", error);
        if (userState[from]) userState[from].history.pop();
        await startMenuFlow(sock, from, "Hubo un problema técnico.");
    }
}

module.exports = { handleMessage };
