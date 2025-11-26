// database.js

const supabase = require('./supabaseClient');

/**
 * DOCUMENTACIÓN:
 * Este archivo centraliza todas las operaciones con la base de datos de Supabase.
 */

async function getCuposDisponibles(tipo, fecha) {
    try {
        const diaSemana = fecha.getDay();
        let claveLimite = `cupos_${tipo}`;
        if (tipo === 'consulta' && diaSemana === 3) { // Miércoles
            claveLimite = 'cupos_consulta_miercoles';
        }

        const { data: config, error: configError } = await supabase.from('configuracion').select('valor').eq('clave', claveLimite).single();
        if (configError) throw configError;
        const limiteCupos = parseInt(config.valor, 10);

        const fechaISO = fecha.toISOString().split('T')[0];
        // Contamos ambos tipos para la consulta general
        const tipoQuery = tipo === 'consulta' ? ['consulta', 'ecor'] : ['reembolso'];
        const { count, error: countError } = await supabase
            .from('solicitudes')
            .select('*', { count: 'exact', head: true })
            .in('tipo_solicitud', tipoQuery) // Usamos 'in' para cubrir consulta y ecor
            .eq('fecha_solicitud', fechaISO);

        if (countError) throw countError;

        return limiteCupos - count;
    } catch (error) {
        console.error('Error al obtener cupos disponibles:', error.message);
        return 0;
    }
}

/**
 * Genera el siguiente número de turno, reiniciando el conteo para cada día.
 * Funciona gracias a la nueva restricción UNIQUE(numero_turno, fecha_solicitud) en la DB.
 * @param {'C' | 'R'} prefijo - El prefijo para el turno (Consulta, Reembolso).
 * @param {Date} fecha - La fecha para la cual se genera el turno.
 * @returns {Promise<string>} - El nuevo número de turno (ej. "C-001").
 */
async function getSiguienteNumeroTurno(prefijo, fecha) {
    try {
        const fechaISO = fecha.toISOString().split('T')[0];
        const tipoSolicitudQuery = (prefijo === 'R') ? ['reembolso'] : ['consulta', 'ecor'];

        const { count, error } = await supabase
            .from('solicitudes')
            .select('*', { count: 'exact', head: true })
            .eq('fecha_solicitud', fechaISO)
            .in('tipo_solicitud', tipoSolicitudQuery);

        if (error) {
            throw error;
        }

        const nuevoNumero = (count || 0) + 1;
        const nuevoTurno = `${prefijo}-${String(nuevoNumero).padStart(3, '0')}`;
        return nuevoTurno;

    } catch (error) {
        console.error('Error al generar el número de turno:', error.message);
        return null;
    }
}

async function crearSolicitud(datosSolicitud) {
    try {
        const { data, error } = await supabase.from('solicitudes').insert([datosSolicitud]).select().single();
        if (error) throw error;
        return data;
    } catch (error) {
        console.error('Error al crear la solicitud en la base de datos:', error.message);
        return null;
    }
}

/**
 * Obtiene todas las solicitudes de un día específico para el reporte.
 * // <-- CAMBIO CLAVE: Ahora acepta un string 'YYYY-MM-DD' directamente.
 * @param {string} fechaString - La fecha del reporte en formato "YYYY-MM-DD".
 * @returns {Promise<Array>} - Un array con todas las solicitudes del día.
 */
async function getDatosReporteDiario(fechaString) {
    try {
        // Ya no necesitamos convertir. Usamos el string directamente.
        const { data, error } = await supabase
            .from('solicitudes')
            .select('*')
            .eq('fecha_solicitud', fechaString);

        if (error) throw error;
        return data;
    } catch (error) {
        console.error('Error al obtener datos para el reporte:', error.message);
        return [];
    }
}

/**
 * Obtiene todas las solicitudes de un mes específico.
 * @param {string} mesString - El mes en formato "YYYY-MM".
 * @returns {Promise<Array>} - Un array con todas las solicitudes del mes.
 */
async function getDatosReporteMensual(mesString) {
    try {
        const startDate = `${mesString}-01`;
        // Calculamos el último día del mes
        const [year, month] = mesString.split('-');
        const lastDay = new Date(year, month, 0).getDate();
        const endDate = `${mesString}-${lastDay}`;

        const { data, error } = await supabase
            .from('solicitudes')
            .select('*')
            .gte('fecha_solicitud', startDate)
            .lte('fecha_solicitud', endDate);

        if (error) throw error;
        return data;
    } catch (error) {
        console.error('Error al obtener datos para el reporte mensual:', error.message);
        return [];
    }
}

/**
 * Verifica si un usuario ya tiene una cita registrada para una fecha específica.
 * @param {string} cedula - La cédula del usuario.
 * @param {Date} fecha - La fecha de la cita.
 * @returns {Promise<boolean>} - True si ya tiene cita, False si no.
 */
async function checkExistingAppointment(cedula, fecha) {
    try {
        const fechaISO = fecha.toISOString().split('T')[0];
        const { data, error } = await supabase
            .from('solicitudes')
            .select('id')
            .eq('cedula', cedula)
            .eq('fecha_solicitud', fechaISO)
            .in('tipo_solicitud', ['consulta', 'ecor']) // Solo verificamos consultas médicas
            .maybeSingle();

        if (error) throw error;
        return !!data; // Retorna true si existe, false si no
    } catch (error) {
        console.error('Error al verificar cita existente:', error.message);
        return false; // En caso de error, permitimos (o podríamos bloquear, depende de la política)
    }
}

// Código completo de las funciones sin cambios para que solo copies y pegues
async function getCuposDisponibles(tipo, fecha) {
    try {
        const diaSemana = fecha.getDay();
        let claveLimite = `cupos_${tipo}`;
        if (tipo === 'consulta' && diaSemana === 3) { claveLimite = 'cupos_consulta_miercoles'; }
        const { data: config, error: configError } = await supabase.from('configuracion').select('valor').eq('clave', claveLimite).single();
        if (configError) throw configError;
        const limiteCupos = parseInt(config.valor, 10);
        const fechaISO = fecha.toISOString().split('T')[0];
        const tipoQuery = tipo === 'consulta' ? ['consulta', 'ecor'] : ['reembolso'];
        const { count, error: countError } = await supabase.from('solicitudes').select('*', { count: 'exact', head: true }).in('tipo_solicitud', tipoQuery).eq('fecha_solicitud', fechaISO);
        if (countError) throw countError;
        return limiteCupos - count;
    } catch (error) {
        console.error('Error al obtener cupos disponibles:', error.message);
        return 0;
    }
}
async function getSiguienteNumeroTurno(prefijo, fecha) {
    try {
        const fechaISO = fecha.toISOString().split('T')[0];
        const tipoSolicitudQuery = (prefijo === 'R') ? ['reembolso'] : ['consulta', 'ecor'];
        const { count, error } = await supabase.from('solicitudes').select('*', { count: 'exact', head: true }).eq('fecha_solicitud', fechaISO).in('tipo_solicitud', tipoSolicitudQuery);
        if (error) { throw error; }
        const nuevoNumero = (count || 0) + 1;
        const nuevoTurno = `${prefijo}-${String(nuevoNumero).padStart(3, '0')}`;
        return nuevoTurno;
    } catch (error) {
        console.error('Error al generar el número de turno:', error.message);
        return null;
    }
}
async function crearSolicitud(datosSolicitud) {
    try {
        const { data, error } = await supabase.from('solicitudes').insert([datosSolicitud]).select().single();
        if (error) throw error;
        return data;
    } catch (error) {
        console.error('Error al crear la solicitud en la base de datos:', error.message);
        return null;
    }
}


module.exports = {
    getCuposDisponibles,
    getSiguienteNumeroTurno,
    crearSolicitud,
    getDatosReporteDiario,
    getDatosReporteMensual,
    checkExistingAppointment,
};
