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
    // Guardar la emergencia en Supabase
    const ahora = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Caracas" }));
    const fechaISO = ahora.toISOString().split('T')[0];
    const horaParaDB = ahora.toTimeString().slice(0, 8);

    await crearSolicitud({
        tipo_solicitud: 'emergencia',
        fecha_solicitud: fechaISO,
        hora_solicitud: horaParaDB,
        numero_turno: 'EMERGENCIA' // Opcional, para identificar
    });

    await sock.sendMessage(from, { text: "Detecté una emergencia. Por favor, comunícate directamente al siguiente número:\n*0265-8053063*" });
}

// =================================================================================
// NUEVA LÓGICA DE BÚSQUEDA DE FECHAS
// =================================================================================

/**
 * Convierte un string de día de la semana a un número (Domingo=0, Lunes=1, etc.).
 * @param {string} dayString - El nombre del día (ej. "Lunes").
 * @returns {number|null} El número del día o null si no es válido.
 */
function getDayOfWeekAsNumber(dayString) {
    if (!dayString) return null;
    const days = {
        'domingo': 0, 'lunes': 1, 'martes': 2, 'miercoles': 3, 'miércoles': 3, 'jueves': 4, 'viernes': 5, 'sabado': 6, 'sábado': 6
    };
    return days[dayString.toLowerCase()] ?? null;
}

/**
 * Determina la fecha inicial para la búsqueda (hoy si es día hábil y antes de las 2 PM, si no, el próximo día hábil).
 * @returns {Date} La fecha inicial para la búsqueda.
 */
function getInitialSearchDate() {
    const ahora = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Caracas" }));
    let fechaBusqueda = new Date(ahora.getFullYear(), ahora.getMonth(), ahora.getDate()); // Normaliza a la medianoche

    const diaSemana = fechaBusqueda.getDay();
    const hora = ahora.getHours();

    // Si es fin de semana, avanza al lunes
    if (diaSemana === 6) { // Sábado
        fechaBusqueda.setDate(fechaBusqueda.getDate() + 2);
    } else if (diaSemana === 0) { // Domingo
        fechaBusqueda.setDate(fechaBusqueda.getDate() + 1);
    }
    // Si es un día de semana pero ya pasó el horario de atención (2 PM)
    else if (hora >= 14) {
        fechaBusqueda.setDate(fechaBusqueda.getDate() + 1);
        // Si al avanzar cae en fin de semana, ajusta al lunes
        if (fechaBusqueda.getDay() === 6) fechaBusqueda.setDate(fechaBusqueda.getDate() + 2);
    }

    return fechaBusqueda;
}

/**
 * Busca la próxima fecha disponible para una cita, opcionalmente a partir de un día deseado.
 * @param {'consulta' | 'reembolso' | 'ecor'} tipo - El tipo de solicitud.
 * @param {string|null} diaDeseadoString - El día de la semana deseado (ej. "Miércoles").
 * @returns {Promise<Date|null>} La fecha encontrada o null si no hay cupos en los próximos 7 días.
 */
async function findNextAvailableDate(tipo, diaDeseadoString = null) {
    let searchDate = getInitialSearchDate();
    const targetDay = getDayOfWeekAsNumber(diaDeseadoString);

    if (targetDay !== null) {
        // Avanza la fecha hasta que coincida con el día de la semana deseado
        while (searchDate.getDay() !== targetDay) {
            searchDate.setDate(searchDate.getDate() + 1);
        }
    }

    // Busca un cupo disponible en los próximos 7 días a partir de la fecha de búsqueda
    for (let i = 0; i < 7; i++) {
        const currentDay = searchDate.getDay();
        // Solo busca en días hábiles (Lunes a Viernes)
        if (currentDay >= 1 && currentDay <= 5) {
            const tipoBusqueda = tipo === 'ecor' ? 'consulta' : tipo;
            const cupos = await getCuposDisponibles(tipoBusqueda, searchDate);
            if (cupos > 0) {
                return searchDate; // ¡Encontramos un cupo!
            }
        }
        // Si no hay cupo o es fin de semana, avanza al siguiente día
        searchDate.setDate(searchDate.getDate() + 1);
    }

    return null; // No se encontraron cupos en la próxima semana
}

/**
 * Función centralizada para manejar la lógica de agendamiento de citas y reembolsos.
 */
async function handleSchedulingRequest(sock, from, tipo, args) {
    userState[from] = { data: args }; // Guarda los datos del usuario
    const diaDeseado = args.dia_semana_deseado;

    // --- NUEVA RESTRICCIÓN: Verificar si ya tiene cita ese día ---
    if (tipo === 'consulta' && args.cedula) {
        // Nota: Necesitamos saber la fecha *antes* de verificar. 
        // Pero la fecha depende de la búsqueda. 
        // Primero buscamos la fecha tentativa, luego verificamos.
    }

    const tipoParaCupos = args.tipo_consulta_detalle === 'Examen físico anual (ECOR)' ? 'ecor' : tipo;

    if (tipoParaCupos === 'ecor') {
        // ECOR no tiene límite de cupos, se agenda para la próxima fecha posible
        let fechaCita = getInitialSearchDate();
        if (diaDeseado) {
            const targetDay = getDayOfWeekAsNumber(diaDeseado);
            if (targetDay !== null) {
                while (fechaCita.getDay() !== targetDay) {
                    fechaCita.setDate(fechaCita.getDate() + 1);
                }
            }
        }
        // Asegurarse que no caiga en fin de semana
        if (fechaCita.getDay() === 0) fechaCita.setDate(fechaCita.getDate() + 1);
        if (fechaCita.getDay() === 6) fechaCita.setDate(fechaCita.getDate() + 2);

        const mensaje = await procesarCreacionSolicitud(from, 'ecor', fechaCita);
        await sock.sendMessage(from, { text: mensaje });
        return true;
    }

    // Para consultas y reembolsos, buscamos el próximo cupo disponible
    const fechaCita = await findNextAvailableDate(tipo, diaDeseado);

    if (fechaCita) {
        // --- VERIFICACIÓN DE CITA EXISTENTE ---
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

        // --- NUEVO FLUJO POST-REGISTRO ---
        // No borramos el estado inmediatamente, lo cambiamos a 'esperando_confirmacion_final'
        userState[from] = { step: 'esperando_confirmacion_final' };
        return false; // Retornamos false para indicar que el flujo NO ha terminado completamente (aunque la tarea principal sí)
    } else {
        const mensajeAviso = diaDeseado
            ? `Lo sentimos, no hay cupos disponibles para el ${diaDeseado} ni en los días siguientes. Por favor, intenta para otra fecha.`
            : "Lo sentimos, no hemos encontrado cupos disponibles en los próximos 7 días. Por favor, intenta de nuevo más tarde.";
        await sock.sendMessage(from, { text: mensajeAviso });
        return true; // Finaliza el flujo
    }
}

async function executeReimbursementRequest(sock, from, args) {
    return await handleSchedulingRequest(sock, from, 'reembolso', args);
}

async function executeAppointmentRequest(sock, from, args) {
    return await handleSchedulingRequest(sock, from, 'consulta', args);
}


// =================================================================================
// FUNCIONES DE SOPORTE (La mayoría sin cambios)
// =================================================================================

/**
 * Lógica central para crear una solicitud en la base de datos y generar el mensaje de éxito.
 */
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
    delete datosParaGuardar.dia_semana_deseado; // Limpiamos el dato auxiliar

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

// Las funciones de menú de respaldo y el manejador principal no necesitan cambios
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

async function handleMessage(sock, msg) {
    const from = jidNormalizedUser(msg.key.remoteJid);
    console.log(`[DEBUG] Mensaje recibido de: ${msg.key.remoteJid} -> Normalizado a: ${from}`);
    const isAudio = msg.message?.audioMessage;
    let originalText = (msg.message?.conversation || msg.message?.extendedTextMessage?.text || '').trim();

    const adminNumber = `${process.env.REPORT_WHATSAPP_NUMBER}@s.whatsapp.net`;

    if (originalText.toLowerCase().startsWith('/reporte-mensual') && from === adminNumber) {
        const parts = originalText.split(' ');
        let mesString = new Date().toISOString().slice(0, 7); // YYYY-MM actual por defecto
        if (parts.length > 1 && /^\d{4}-\d{2}$/.test(parts[1])) {
            mesString = parts[1];
        }
        await sock.sendMessage(from, { text: `Recibido. Generando el reporte MENSUAL para ${mesString}...` });
        await generateAndSendMonthlyReport(sock, adminNumber, mesString);
        return;
    }

    if (originalText.toLowerCase().startsWith('/reporte') && from === adminNumber) {
        const parts = originalText.split(' ');
        let fechaString = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Caracas' });
        if (parts.length > 1 && /^\d{4}-\d{2}-\d{2}$/.test(parts[1])) {
            fechaString = parts[1];
        }
        const fechaDisplay = new Date(fechaString + 'T12:00:00Z');
        await sock.sendMessage(from, { text: `Recibido. Generando el reporte para el día ${fechaDisplay.toLocaleDateString('es-VE')}...` });
        await generateAndSendReports(sock, adminNumber, fechaString);
        return;
    }

    if (originalText.toLowerCase() === 'menu') {
        delete userState[from];
        await startMenuFlow(sock, from, "Ok, empecemos de nuevo.");
        return;
    }

    // La lógica de confirmación para el día siguiente ya no es necesaria con el nuevo sistema.
    const currentState = userState[from];

    // --- NUEVO MANEJADOR DE CONFIRMACIÓN FINAL ---
    if (currentState && currentState.step === 'esperando_confirmacion_final') {
        const respuesta = originalText.toLowerCase();
        if (respuesta.includes('no') || respuesta.includes('gracias') || respuesta.includes('listo')) {
            await sock.sendMessage(from, { text: "Estamos para servirle, que tenga un gran día." });
            delete userState[from];
            return;
        } else {
            // Si dice otra cosa (ej: "tengo una emergencia"), borramos el estado "finalizado"
            // y dejamos que el flujo continúe hacia la IA para que ella interprete el mensaje.
            delete userState[from];
            // NO hacemos return aquí, para que caiga en la lógica de IA de abajo
        }
    }

    if (currentState && currentState.step === 'menu_principal_respuesta') {
        await handleMenuResponse(sock, from, originalText);
        return;
    }

    if (isAudio) {
        try {
            console.log(`[DEBUG] Recibida nota de voz de ${from}. Iniciando descarga...`);
            await sock.sendMessage(from, { text: "Procesando tu nota de voz, un momento..." });

            const buffer = await downloadMediaMessage(msg, 'buffer', {});
            console.log(`[DEBUG] Audio descargado. Tamaño del buffer: ${buffer ? buffer.length : 'NULO'} bytes`);

            if (!buffer || buffer.length === 0) {
                console.error("[ERROR] El buffer de audio está vacío o es nulo.");
                await sock.sendMessage(from, { text: "Hubo un error al descargar el audio. Por favor intenta de nuevo." });
                return;
            }

            originalText = await transcribeAudio(buffer);
            console.log(`[DEBUG] Resultado de transcripción: "${originalText}"`);

            if (!originalText) {
                console.warn("[WARN] La transcripción retornó null o vacío.");
                await sock.sendMessage(from, { text: "Lo siento, no pude procesar tu nota de voz. Por favor, ¿podrías escribir tu solicitud?" });
                return;
            }
            console.log(`Audio transcrito como: "${originalText}"`);
        } catch (error) {
            console.error("Error crítico durante el procesamiento de audio:", error);
            await sock.sendMessage(from, { text: "Hubo un problema inesperado con tu nota de voz. Por favor, intenta de nuevo." });
            return;
        }
    }

    if (!originalText) return;
    if (!userState[from] || !userState[from].history) {
        userState[from] = { history: [] };
    }
    userState[from].history.push({ role: 'user', content: originalText });

    try {
        const aiResponse = await processConversationWithAI(userState[from].history);

        if (!aiResponse) {
            console.log("FALLO TOTAL DE LA IA. Activando modo menú de respaldo.");
            userState[from].history.pop();
            await startMenuFlow(sock, from, "Lo siento, nuestro asistente inteligente no está disponible en este momento.");
            return;
        }

        if (aiResponse.type === 'reply' && aiResponse.content) {
            userState[from].history.push({ role: 'assistant', content: aiResponse.content });
            await sock.sendMessage(from, { text: aiResponse.content });
        } else if (aiResponse.type === 'tool_call' && aiResponse.call?.name) {
            let taskCompleted = true;
            const toolName = aiResponse.call.name;
            const toolArgs = JSON.parse(aiResponse.call.arguments || '{}');
            console.log(`[+] Ejecutando herramienta: ${toolName}`, toolArgs);
            if (toolName === 'informar_emergencia') await executeEmergencyCall(sock, from);
            else if (toolName === 'solicitar_reembolso') taskCompleted = await executeReimbursementRequest(sock, from, toolArgs);
            else if (toolName === 'agendar_solicitud') taskCompleted = await executeAppointmentRequest(sock, from, toolArgs);
            else throw new Error(`Herramienta desconocida: ${toolName}`);

            if (taskCompleted) {
                // Solo borramos si taskCompleted es true Y no estamos en el paso de confirmación final
                if (userState[from]?.step !== 'esperando_confirmacion_final') {
                    delete userState[from];
                }
            }
        } else {
            userState[from].history.pop();
            throw new Error(`Respuesta no reconocida de la IA: ${JSON.stringify(aiResponse)}`);
        }
    } catch (error) {
        console.error("Error en flujo de IA. Activando modo menú de respaldo:", error);
        if (userState[from] && userState[from].history) {
            userState[from].history.pop();
        }
        await startMenuFlow(sock, from, "Hubo un problema con el asistente.");
    }
}

module.exports = { handleMessage };