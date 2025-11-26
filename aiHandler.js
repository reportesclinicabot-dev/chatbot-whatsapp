// aiHandler.js

const axios = require('axios');
const FormData = require('form-data');
const { HfInference } = require('@huggingface/inference');
const { GoogleGenerativeAI } = require('@google/generative-ai');
require('dotenv').config();

/**
 * Transcribe un buffer de audio a texto usando la API oficial de OpenAI (Whisper).
 * @param {Buffer} audioBuffer - El buffer de audio (en formato ogg).
 * @returns {Promise<string|null>} El texto transcrito o null si hay un error.
 */
async function transcribeAudio(audioBuffer) {
    // Intentar primero con Hugging Face (Whisper Large v3-turbo)
    const hfApiKey = process.env.HUGGINGFACE_API_KEY;
    if (hfApiKey) {
        console.log('Intentando transcribir con Hugging Face (Whisper Large v3-turbo)...');
        try {
            // Usar el cliente oficial de Hugging Face Inference
            const hf = new HfInference(hfApiKey);

            // Convertir el buffer a Blob para la API
            const audioBlob = new Blob([audioBuffer], { type: 'audio/ogg' });

            const response = await hf.automaticSpeechRecognition({
                model: 'openai/whisper-large-v3-turbo',
                data: audioBlob
            });

            if (response && response.text) {
                console.log(`Transcripción completa (Hugging Face): "${response.text}"`);
                return response.text;
            } else {
                console.warn("Respuesta de Hugging Face inesperada:", JSON.stringify(response));
                // No retornamos aquí, dejamos que caiga al fallback
            }
        } catch (error) {
            console.error("Error con Hugging Face:", error.message);
            if (error.response) {
                console.error("Detalles del error HF:", JSON.stringify(error.response.data));
                console.error("Status Code HF:", error.response.status);
            }
            console.log("Procediendo con el proveedor de respaldo (OpenAI)...");
        }
    } else {
        console.log("HUGGINGFACE_API_KEY no encontrada. Usando OpenAI directamente.");
    }

    // Fallback: OpenAI (Whisper)
    const openAiApiKey = process.env.OPENAI_API_KEY;
    if (!openAiApiKey) {
        console.error("API Key de OpenAI no encontrada. No se puede transcribir.");
        return null;
    }
    console.log('Enviando audio a la API de OpenAI (Whisper)...');

    const form = new FormData();
    form.append('file', audioBuffer, { filename: 'audio.ogg' });
    form.append('model', 'whisper-1');

    try {
        const response = await axios.post('https://api.openai.com/v1/audio/transcriptions', form, {
            headers: {
                'Authorization': `Bearer ${openAiApiKey}`,
                ...form.getHeaders()
            }
        });

        const transcribedText = response.data?.text || '';
        console.log(`Transcripción completa (OpenAI): "${transcribedText}"`);
        return transcribedText;
    } catch (error) {
        console.error("Error al transcribir audio con OpenAI:", error.message);
        if (error.response) {
            console.error("Detalles del error OpenAI:", JSON.stringify(error.response.data));
        }
        return null;
    }
}


/**
 * Las instrucciones completas que definen la personalidad y el flujo de trabajo del asistente de IA.
 */
const systemPrompt = `Eres un asistente robótico de recolección de datos para una clínica. Tu única misión es seguir las secuencias de preguntas al pie de la letra.

**REGLA DE COMPORTAMIENTO INQUEBRANTABLE:**
- Tu función es: 1. Hacer la siguiente pregunta de la lista. 2. Esperar la respuesta. 3. Repetir.
- NO intentes adivinar información ni completar varios pasos a la vez.
- **NUNCA respondas con un JSON a menos que sea la respuesta FINAL de una secuencia completa.**
- **NUEVA CAPACIDAD**: El usuario puede especificar un día de la semana para su cita o reembolso (ej: "para el lunes", "el miércoles"). Si lo hace, debes capturar ese día.

**PASO 1: PRIMER CONTACTO**
Tu PRIMERA respuesta a un usuario nuevo DEBE SER el saludo estándar, A MENOS QUE el usuario manifieste una intención clara o emergencia inmediata.
Saludo Estándar:
"¡Hola! Soy el asistente virtual de la Clínica del Muelle Rafael Urdaneta. Te recuerdo que nuestro horario de atención es de 8:00 AM a 2:00 PM. ¿Cómo puedo ayudarte hoy? Indica el número de tu opción:

*-1-* Agendar una Cita
*-2-* Solicitar un Reembolso
*-3-* Emergencia"

**PASO 2: SECUENCIAS**
Basado en la respuesta del usuario, sigue la secuencia correspondiente.

**SECUENCIA "Agendar Cita":**
1.  **Pregunta (Texto):** "¿Claro! Antes de continuar, por favor asegúrate de que tu historia médica se encuentra en la clínica de Muelle Rafael Urdaneta. ¿Deseas continuar?"
2.  **Pregunta con Opciones (Texto):** "¿Qué tipo de consulta necesitas? Puedes solicitarla para un día específico si lo deseas (ej: 'Consulta integral para el martes').\n\n*-1-* Consulta Integral\n*-2-* Reposo Médico\n*-3-* Examen Físico Anual (ECOR)"
3.  **Pregunta (Texto):** "¿A nombre de quién será la cita? Por favor, indica nombre y apellido."
    // Instrucción de Validación: Después de esta pregunta, si solo recibes una palabra (ej: "Mia"), DEBES preguntar: "¿Y cuál sería el apellido?". NO continúes hasta tener al menos dos palabras.
4.  **Pregunta (Texto):** "¿Cuál es el número de cédula del paciente?"
5.  **Pregunta con Opciones (Texto):** "¿A qué tipo de nómina perteneces? Por favor, elige una:\n\n*-1-* Contractual Diaria\n*-2-* Contractual Mensual\n*-3-* No Contractual"
6.  **Pregunta (Texto):** "Para finalizar, por favor, indícame a qué gerencia perteneces."
7.  **Acción Final (JSON):** Al recibir la gerencia, genera el JSON \`{"accion": "agendar_solicitud", ...}\`.

**SECUENCIA "Solicitar Reembolso":**
1.  **Pregunta (Texto):** "¿A nombre de quién será el reembolso? Puedes indicar si es para un día específico. Por favor, indica nombre y apellido."
    // Instrucción de Validación: Aplica la misma lógica de validación de nombre y apellido.
2.  **Pregunta (Texto):** "¿Cuál es el número de cédula?"
3.  **Acción Final (JSON):** Al recibir la cédula, genera el JSON \`{"accion": "solicitar_reembolso", ...}\`.

**CIERRE DE INTERACCIÓN:**
Si el usuario dice "gracias", "excelente", "listo" o se despide al final, responde SIEMPRE:
"Estamos para servirles."

**REGLA FINAL: LA GENERACIÓN DEL JSON DE ACCIÓN**
Al final de una secuencia, tu respuesta DEBE SER ÚNICA Y EXCLUSIVAMENTE un objeto JSON. Si el usuario especificó un día, AÑADE la clave "dia_semana_deseado".

- Citas: \`{"accion": "agendar_solicitud", "datos": {"tipo_consulta_detalle": "...", "nombre_paciente": "...", "apellido_paciente": "...", "cedula": "...", "nomina": "...", "gerencia": "...", "dia_semana_deseado": "Martes"}}\` (dia_semana_deseado es opcional)
- Reembolsos: \`{"accion": "solicitar_reembolso", "datos": {"nombre_paciente": "...", "apellido_paciente": "...", "cedula": "...", "dia_semana_deseado": "Lunes"}}\` (dia_semana_deseado es opcional)
- Emergencias: \`{"accion": "informar_emergencia"}\`
`;

/**
 * Procesa la respuesta de la IA. Extrae el bloque JSON si existe y lo formatea como 'tool_call'.
 * De lo contrario, lo formatea como una respuesta de texto 'reply'.
 */
function parseAIResponse(rawResponse) {
    const firstBracket = rawResponse.indexOf('{');
    const lastBracket = rawResponse.lastIndexOf('}');
    if (firstBracket === -1 || lastBracket === -1 || lastBracket < firstBracket) {
        console.log("Respuesta de texto detectada (no se encontró un bloque JSON).");
        return { type: 'reply', content: rawResponse };
    }
    const jsonString = rawResponse.substring(firstBracket, lastBracket + 1);
    try {
        const jsonResponse = JSON.parse(jsonString);
        if (jsonResponse && jsonResponse.accion) {
            console.log("JSON de acción detectado:", jsonResponse);
            if (jsonResponse.accion === 'informar_emergencia') {
                return { type: 'tool_call', call: { name: 'informar_emergencia', arguments: '{}' } };
            }
            return { type: 'tool_call', call: { name: jsonResponse.accion, arguments: JSON.stringify(jsonResponse.datos || {}) } };
        }
    } catch (e) {
        console.error("Error al parsear el bloque JSON extraído. Tratando como texto.", e.message);
        return { type: 'reply', content: rawResponse };
    }
    console.warn("Se recibió un JSON válido pero sin 'accion', tratándolo como texto:", rawResponse);
    return { type: 'reply', content: rawResponse };
}

/**
 * --- Proveedor #1: Google AI Studio (Principal) ---
 */
async function processWithGoogleAI(conversationHistory) {
    const apiKey = process.env.GOOGLE_API_KEY;
    if (!apiKey) throw new Error("API Key de Google no encontrada.");
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({
        // <-- CAMBIO REALIZADO AQUÍ
        model: "gemini-flash-latest",
        systemInstruction: systemPrompt,
    });
    const googleCompatibleHistory = conversationHistory.map(msg => ({
        role: msg.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: msg.content }]
    }));
    const result = await model.generateContent({
        contents: googleCompatibleHistory,
        generationConfig: { temperature: 0.2 },
    });
    const rawResponse = result.response.text();
    console.log("Respuesta cruda de Google AI:", rawResponse);
    return parseAIResponse(rawResponse);
}

/**
 * --- Proveedor #2: OpenRouter (Respaldo) ---
 */
async function processWithOpenRouter(conversationHistory) {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) throw new Error("API Key de OpenRouter no encontrada.");
    const messagesWithSystemPrompt = [{ role: 'system', content: systemPrompt }, ...conversationHistory];
    const response = await axios.post('https://openrouter.ai/api/v1/chat/completions', {
        // <-- CAMBIO REALIZADO AQUÍ
        model: 'nvidia/nemotron-nano-12b-v2-vl:free',
        messages: messagesWithSystemPrompt,
    }, {
        headers: { 'Authorization': `Bearer ${apiKey}` }
    });
    const message = response?.data?.choices?.[0]?.message;
    if (message && message.content) {
        const rawResponse = message.content;
        console.log("Respuesta cruda de OpenRouter:", rawResponse);
        return parseAIResponse(rawResponse);
    } else {
        console.error("Estructura de respuesta de OpenRouter inesperada:", JSON.stringify(response.data, null, 2));
        throw new Error('La respuesta de OpenRouter no tiene el formato esperado.');
    }
}

/**
 * --- Orquestador Principal de IA con Lógica de Reintentos Mejorada ---
 */
async function processConversationWithAI(conversationHistory) {
    const MAX_RETRIES = 3;
    const RETRY_DELAY = 2000;
    let attempt = 0;

    // Intento con Google AI (Principal)
    while (attempt < MAX_RETRIES) {
        attempt++;
        try {
            console.log(`Intentando con Google AI (Intento ${attempt}/${MAX_RETRIES})...`);
            return await processWithGoogleAI(conversationHistory);
        } catch (googleError) {
            console.error(`Error con Google AI en el intento ${attempt}:`, googleError.message);

            const errorMessage = googleError.message.toLowerCase();
            const isOverloaded = errorMessage.includes('503') || errorMessage.includes('overloaded');
            const isQuotaError = errorMessage.includes('429') || errorMessage.includes('quota');
            const isApiKeyError = errorMessage.includes('api key');

            if (isApiKeyError || isQuotaError) {
                console.log("Error de API Key o Cuota Excedida. Pasando directamente al proveedor de respaldo.");
                break;
            }

            if (isOverloaded && attempt < MAX_RETRIES) {
                console.log(`Servidor sobrecargado. Reintentando en ${RETRY_DELAY / 1000} segundos...`);
                await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
                continue;
            }
            break;
        }
    }

    // Fallback: OpenRouter
    console.log("Google AI no disponible. Intentando con el proveedor de respaldo: OpenRouter...");
    try {
        return await processWithOpenRouter(conversationHistory);
    } catch (openRouterError) {
        console.error("OpenRouter (respaldo) también falló.", openRouterError.message);
        // Fallback final: Devolver null para que messageHandler active el menú de respaldo
        return null;
    }
}


module.exports = {
    transcribeAudio,
    processConversationWithAI,
};