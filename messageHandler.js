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
// FUNCIONES DE SOPORTE
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
// HANDLER PRINCIPAL (Lógica de Comandos Corregida)
// =================================================================================
async function handleMessage(sock, msg) {
    const from = jidNormalizedUser(msg.key.remoteJid);
    const senderNumber = from.split('@')[0]; // Número limpio de quien escribe
    const envAdminNumber = (process.env.REPORT_WHATSAPP_NUMBER || '').replace(/[^0-9]/g, ''); // Número limpio del admin

    // --- DEBUGGING VISIBLE EN CONSOLA ---
    // Esto te dirá por qué falla si el número no coincide
    console.log(`[DEBUG] Mensaje de: ${senderNumber} | Admin esperado: ${envAdminNumber} | Texto: ${msg.message?.conversation || 'multimedia'}`);

    const isAudio = msg.message?.audioMessage;
    let originalText = (msg.message?.conversation || msg.message?.extendedTextMessage?.text || '').trim();

    // -------------------------------------------------------------
    // BLOQUE DE COMANDOS DE ADMINISTRADOR (Prioridad Alta)
    // -------------------------------------------------------------
    if (originalText.startsWith('/')) {
        const command = originalText.toLowerCase().split(' ')[0];
        const isAdmin = senderNumber === envAdminNumber;

        // 1. REPORTE MENSUAL: /reporte-mensual (opcional: YYYY-MM)
        if (command === '/reporte-mensual') {
            if (!isAdmin) {
                console.log(`[SEGURIDAD] Usuario ${senderNumber} intentó usar comando admin.`);
                return;
            }
            const parts = originalText.split(' ');
            let mesString = new Date().toISOString().slice(0, 7); // Default: Mes actual
            if (parts.length > 1 && /^\d{4}-\d{2}$/.test(parts[1])) {
                mesString = parts[1];
            }
            
            await sock.sendMessage(from, { text: `📊 Recibido. Generando reporte MENSUAL (${mesString})... por favor espera.` });
            console.log(`[COMANDO] Generando reporte mensual para ${mesString}`);
            await generateAndSendMonthlyReport(sock, from, mesString);
            return; // Detenemos ejecución aquí
        }

        // 2. REPORTE DIARIO: /reporte (opcional: YYYY-MM-DD)
        if (command === '/reporte') {
            if (!isAdmin) {
                console.log(`[SEGURIDAD] Usuario ${senderNumber} intentó usar comando admin.`);
                return;
            }
            const parts = originalText.split(' ');
            let fechaString = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Caracas' }); // Default: Hoy
            if (parts.length > 1 && /^\d{4}-\d{2}-\d{2}$/.test(parts[1])) {
                fechaString = parts[1];
            }

            await sock.sendMessage(from, { text: `📈 Recibido. Generando reporte DIARIO (${fechaString})... por favor espera.` });
            console.log(`[COMANDO] Generando reporte diario para ${fechaString}`);
            await generateAndSendReports(sock, from, fechaString);
            return; // Detenemos ejecución aquí
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
            // Si dice otra cosa, dejamos que la IA continúe
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
            console.log(`[AUDIO] Recibido de ${from}. Procesando...`);
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
            console.log("IA no disponible. Usando menú de respaldo.");
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
