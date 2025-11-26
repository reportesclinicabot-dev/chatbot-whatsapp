const axios = require('axios');
const FormData = require('form-data');

require('dotenv').config();

// Token provided by user
const TOKEN = process.env.HUGGINGFACE_API_KEY;

async function checkToken() {
    console.log(`\n--- Checking Token Validity ---`);
    try {
        const response = await axios.get('https://huggingface.co/api/whoami', {
            headers: { 'Authorization': `Bearer ${TOKEN}` }
        });
        console.log(`Status: ${response.status}`);
        console.log(`User: ${response.data.name}`);
        console.log(`Type: ${response.data.type}`);
        return true;
    } catch (error) {
        console.log(`Error: ${error.message}`);
        if (error.response) {
            console.log(`Response: ${JSON.stringify(error.response.data)}`);
        }
        return false;
    }
}

async function testEndpoint(url, description, isFormData = false) {
    console.log(`\n--- Testing: ${description} ---`);
    console.log(`URL: ${url}`);
    try {
        let data;
        let headers = { 'Authorization': `Bearer ${TOKEN}` };

        if (isFormData) {
            const form = new FormData();
            const dummyBuffer = Buffer.from("dummy audio content");
            form.append('file', dummyBuffer, { filename: 'test.ogg', contentType: 'audio/ogg' });
            form.append('model', 'openai/whisper-large-v3');
            data = form;
            headers = { ...headers, ...form.getHeaders() };
        } else {
            data = Buffer.from("dummy audio content");
            headers['Content-Type'] = 'audio/ogg';
        }

        const response = await axios.post(url, data, { headers, validateStatus: () => true });
        console.log(`Status: ${response.status}`);
        console.log(`Response: ${JSON.stringify(response.data).substring(0, 300)}`);
    } catch (error) {
        console.log(`Error: ${error.message}`);
    }
}

async function runTests() {
    const isValid = await checkToken();
    if (!isValid) {
        console.log("Token check failed (whoami). Proceeding to endpoint tests anyway to verify inference permissions...");
        // return;
    }

    // 1. Router API - OpenAI Compatible (Generic)
    await testEndpoint(
        'https://router.huggingface.co/v1/audio/transcriptions',
        'Router API - OpenAI Compatible Generic (FormData)',
        true
    );

    // 2. Router API - OpenAI Compatible (Model Specific)
    await testEndpoint(
        'https://router.huggingface.co/openai/whisper-large-v3/v1/audio/transcriptions',
        'Router API - OpenAI Compatible Model Specific (FormData)',
        true
    );

    // 3. Inference API - OpenAI Compatible
    await testEndpoint(
        'https://api-inference.huggingface.co/models/openai/whisper-large-v3/v1/audio/transcriptions',
        'Inference API - OpenAI Compatible (FormData)',
        true
    );

    // 5. Standard Inference API (Tiny - Binary)
    await testEndpoint(
        'https://api-inference.huggingface.co/models/openai/whisper-tiny',
        'Standard Inference API (Tiny - Binary)',
        false
    );
}

runTests();
