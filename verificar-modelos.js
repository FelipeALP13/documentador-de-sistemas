const { readConfig, listModels, createModel, withRetry, responseText, safeMessage } = require('./gemini-client');

async function main() {
    const args = process.argv.slice(2);
    if (args.some(arg => arg !== '--testar')) throw new Error('Uso: node verificar-modelos.js [--testar]');
    const config = readConfig();
    const models = await listModels(config);
    console.log('Modelos listados com generateContent (a listagem não garante quota ou disponibilidade):');
    models.forEach(model => console.log(model.name));
    console.log(`\nModelo configurado: ${config.model}`);
    if (args.includes('--testar')) {
        const model = await createModel(config);
        const text = await withRetry(async () => {
            const result = await model.generateContent('Responda apenas: OK');
            return responseText(result.response);
        }, config);
        console.log(`Teste de texto concluído (${text.length} caracteres). Para validar imagem: node gerar-manual.js --limite=1`);
    }
}

if (require.main === module) main().catch(error => { console.error(safeMessage(error)); process.exitCode = 1; });
