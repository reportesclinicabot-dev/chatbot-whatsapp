// supabaseClient.js

// Importamos las librerías necesarias
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config(); // Carga las variables de entorno del archivo .env

// Obtenemos la URL y la clave de servicio de nuestras variables de entorno
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

// Creamos y exportamos el cliente de Supabase
// Este cliente será utilizado para todas las interacciones con la base de datos
const supabase = createClient(supabaseUrl, supabaseKey);

module.exports = supabase;